// server.js
import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"], credentials: true },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3001;

/* --- Cartes / points (variante B) --- */
const suits = ["♠","♥","♦","♣"];
const ranks = ["7","8","9","J","Q","K","10","A"]; // storage order (not strength)
const pointsAtout = { "7":0,"8":0,"9":14,"J":20,"Q":3,"K":4,"10":10,"A":11 };
const pointsNormal = { "7":0,"8":0,"9":0,"J":2,"Q":3,"K":4,"10":10,"A":11 };

/* --- Helpers --- */
function shuffle(arr){ return arr.sort(()=>Math.random()-0.5); }
function createDeck(){
  const d=[];
  for(const s of suits) for(const r of ranks) d.push({suit:s,rank:r});
  return shuffle(d);
}
function playerIndex(room, pid){ return rooms[room].players.findIndex(p=>p.id===pid); }
function teamIndex(room, pid){
  const r = rooms[room];
  if(r.teams) return r.teams.teamA.includes(pid) ? 0 : 1;
  const idx = playerIndex(room, pid);
  return (idx % 2 === 0) ? 0 : 1;
}

/* Ranking for comparing cards in variant B (trump special) */
const trumpOrder = {"J":8,"9":7,"A":6,"10":5,"K":4,"Q":3,"8":2,"7":1};
const notrumpOrder = {"A":8,"10":7,"K":6,"Q":5,"J":4,"9":3,"8":2,"7":1};

function compareCards(a,b,leadSuit,trump){
  const aIsTrump = a.suit === trump;
  const bIsTrump = b.suit === trump;
  if(aIsTrump && !bIsTrump) return 1;
  if(!aIsTrump && bIsTrump) return -1;
  if(a.suit === b.suit){
    const ord = aIsTrump ? trumpOrder : notrumpOrder;
    return Math.sign(ord[a.rank] - ord[b.rank]);
  }
  if(a.suit === leadSuit) return 1;
  if(b.suit === leadSuit) return -1;
  return Math.sign(notrumpOrder[a.rank] - notrumpOrder[b.rank]);
}

function trickPoints(trick, trump){
  return trick.reduce((sum,t)=>{
    const isTr = t.card.suit === trump;
    const pts = isTr ? pointsAtout[t.card.rank] : pointsNormal[t.card.rank];
    return sum + pts;
  },0);
}

/* Legal plays enforcement (follow suit, trump, overtrump) */
function legalPlayIndices(hand, trick, trump){
  if(trick.length === 0) return hand.map((_,i)=>i);
  const lead = trick[0].card.suit;
  const hasLead = hand.some(c=>c.suit === lead);
  if(hasLead) return hand.map((c,i)=> c.suit === lead ? i : -1).filter(i=>i>=0);
  const hasTrump = hand.some(c=>c.suit === trump);
  if(!hasTrump) return hand.map((_,i)=>i);
  // must play trump; if there is a trump in trick, must overtrump if possible
  const trickTrumps = trick.filter(t=>t.card.suit === trump);
  if(trickTrumps.length === 0) return hand.map((c,i)=> c.suit===trump ? i : -1).filter(i=>i>=0);
  // find max trump in trick
  let best = trickTrumps[0].card;
  trickTrumps.forEach(t => { if(trumpOrder[t.card.rank] > trumpOrder[best.rank]) best = t.card; });
  const over = hand.map((c,i)=> (c.suit===trump && trumpOrder[c.rank] > trumpOrder[best.rank]) ? i : -1).filter(i=>i>=0);
  if(over.length) return over;
  return hand.map((c,i)=> c.suit===trump ? i : -1).filter(i=>i>=0);
}

/* --- Rooms store --- */
const rooms = {}; // roomName -> state

/* --- Game flow functions --- */
function startDeal(room){
  const r = rooms[room];
  r.deck = createDeck();
  r.phase = "bidding_first";
  r.hands = {};
  r.tricks = [];
  r.beloteCandidates = {}; // pid -> {hasBothAtStart:bool, declared:false}
  // deal 5 to each (we use simple 5 each)
  for(let i=0;i<4;i++){
    const idx = (r.dealerIndex + 1 + i) % 4;
    const pid = r.players[idx].id;
    r.hands[pid] = r.deck.slice(i*5, i*5+5);
  }
  r.turnedCard = r.deck[20]; // show card for first bidding
  r.bidPasses = 0;
  r.bidIndex = (r.dealerIndex + 1) % 4;
  r.currentPlayerIndex = r.bidIndex;
  // prepare belote candidate detection (who holds K+Q of future trump will be checked later once trump known)
  // broadcast private hands
  r.players.forEach(p => io.to(p.id).emit("hand", r.hands[p.id]));
  io.to(room).emit("dealStarted", { players: r.players.map(p=>({id:p.id,name:p.name})), turnedCard: r.turnedCard, dealerIndex: r.dealerIndex, currentBidIndex: r.bidIndex });
}

function finalizeTakeFirst(room, takerIdx, chosenSuit){
  const r = rooms[room];
  r.trump = chosenSuit;
  r.phase = "playing";
  // build pool for final 3 cards each: take remaining cards (after first 5*4 + turned) and include turned card to make 12
  const tail = r.deck.slice(21); // 11 cards
  const finalPool = tail.concat([r.turnedCard]); // 12 cards
  // distribute 3 to each in order dealer+1 .. dealer+4
  for(let i=0;i<4;i++){
    const idx = (r.dealerIndex + 1 + i) % 4;
    const pid = r.players[idx].id;
    r.hands[pid] = r.hands[pid].concat(finalPool.slice(i*3, i*3+3));
  }
  // detect belote candidates (who holds both K and Q of trump at start)
  r.players.forEach(p=>{
    const h = r.hands[p.id] || [];
    const hasK = h.some(c => c.suit === r.trump && c.rank === "K");
    const hasQ = h.some(c => c.suit === r.trump && c.rank === "Q");
    r.beloteCandidates[p.id] = { hasBoth: hasK && hasQ, declared:false };
  });
  // set first player to left of dealer
  r.currentPlayerIndex = (r.dealerIndex + 1) % 4;
  // send updated hands and atout
  r.players.forEach(p => io.to(p.id).emit("hand", r.hands[p.id]));
  io.to(room).emit("atoutChosen", { atout: r.trump, dealerIndex: r.dealerIndex });
}

/* --- Socket handlers --- */
io.on("connection", socket => {
  console.log("conn", socket.id);

  socket.on("join", ({ room, name }) => {
    if(!room) return socket.emit("error", "Room required");
    if(!rooms[room]) {
      rooms[room] = {
        players: [],
        hands: {},
        deck: [],
        turnedCard: null,
        phase: "waiting",
        dealerIndex: 0,
        currentPlayerIndex: 0,
        trump: null,
        scores: [0,0],
        teams: null,
        tricks: [],
        trickHistory: []
      };
    }
    const r = rooms[room];
    if(r.players.length >= 4) return socket.emit("error", "Salle pleine");
    r.players.push({ id: socket.id, name: name || "Joueur" });
    socket.join(room);
    io.to(room).emit("players", r.players.map(p=>({id:p.id,name:p.name})));

    // if 4 players and waiting -> choose dealer
    if(r.players.length === 4 && r.phase === "waiting"){
      r.phase = "chooseDealer";
      io.to(room).emit("chooseDealer", { players: r.players.map(p=>({id:p.id,name:p.name})) });
    }
  });

  socket.on("setTeams", ({ room, teams }) => {
    const r = rooms[room]; if(!r) return;
    r.teams = teams;
    io.to(room).emit("teamsSet", r.teams);
  });

  socket.on("setDealer", ({ room, dealerId }) => {
    const r = rooms[room]; if(!r) return;
    const idx = r.players.findIndex(p=>p.id === dealerId);
    if(idx < 0) return;
    r.dealerIndex = idx;
    startDeal(room);
  });

  /* First round bidding: take or pass the turned suit */
  socket.on("bidFirst", ({ room, take }) => {
    const r = rooms[room]; if(!r) return;
    if(r.phase !== "bidding_first") return socket.emit("error","Not in first bidding phase");
    const expected = r.players[r.bidIndex % 4].id;
    if(expected !== socket.id) return socket.emit("error","Not your bid turn");
    if(take){
      finalizeTakeFirst(room, r.bidIndex % 4, r.turnedCard.suit);
      r.bidTaker = socket.id;
      io.to(room).emit("bidTaken", { playerId: socket.id, suit: r.trump });
      return;
    } else {
      r.bidPasses++;
      r.bidIndex++;
      r.currentPlayerIndex = r.bidIndex % 4;
      io.to(room).emit("bidPassed", { playerId: socket.id, next: r.currentPlayerIndex });
      if(r.bidPasses >= 4){
        r.phase = "bidding_second";
        r.bidIndex = (r.dealerIndex + 1) % 4;
        r.currentPlayerIndex = r.bidIndex;
        io.to(room).emit("biddingSecondStart", { current: r.currentPlayerIndex, turnedSuit: r.turnedCard.suit });
      }
    }
  });

  /* Second round bidding: take another suit or pass */
  socket.on("bidSecond", ({ room, take, suit }) => {
    const r = rooms[room]; if(!r) return;
    if(r.phase !== "bidding_second") return socket.emit("error","Not in second bidding");
    const expected = r.players[r.bidIndex % 4].id;
    if(expected !== socket.id) return socket.emit("error","Not your bid turn (2)");
    if(take){
      if(suit === r.turnedCard.suit) return socket.emit("error","Cannot choose turned suit in second round");
      r.trump = suit;
      r.phase = "playing";
      // distribute final 3 cards each from pool = remaining + turned card
      const tail = r.deck.slice(21);
      const pool = tail.concat([r.turnedCard]);
      for(let i=0;i<4;i++){
        const idx = (r.dealerIndex + 1 + i) % 4;
        const pid = r.players[idx].id;
        r.hands[pid] = r.hands[pid].concat(pool.slice(i*3, i*3+3));
      }
      // detect belote candidates
      r.players.forEach(p=>{
        const h = r.hands[p.id] || [];
        const hasK = h.some(c => c.suit === r.trump && c.rank === "K");
        const hasQ = h.some(c => c.suit === r.trump && c.rank === "Q");
        r.beloteCandidates = r.beloteCandidates || {};
        r.beloteCandidates[p.id] = { hasBoth: hasK && hasQ, declared:false };
      });
      r.currentPlayerIndex = (r.dealerIndex + 1) % 4;
      // emit updated hands
      r.players.forEach(p => io.to(p.id).emit("hand", r.hands[p.id]));
      io.to(room).emit("atoutChosen", { atout: r.trump, dealerIndex: r.dealerIndex });
      return;
    } else {
      r.bidIndex++;
      r.currentPlayerIndex = r.bidIndex % 4;
      io.to(room).emit("bidSecondPassed", { playerId: socket.id, next: r.currentPlayerIndex });
      // if everyone passed in second round -> redeal and rotate dealer
      if(r.bidIndex - (r.dealerIndex + 1) >= 4){
        // rotate dealer
        r.dealerIndex = (r.dealerIndex + 1) % 4;
        startDeal(room);
      }
    }
  });

  socket.on("requestHand", ({ room }) => {
    const r = rooms[room]; if(!r) return;
    const hand = r.hands[socket.id] || [];
    io.to(socket.id).emit("hand", hand);
  });

  /* Play a card */
  socket.on("play", ({ room, cardIndex }) => {
    const r = rooms[room]; if(!r) return;
    if(r.phase !== "playing") return socket.emit("error","Game not in playing phase");
    const pid = socket.id;
    const pIdx = r.players.findIndex(p=>p.id===pid);
    if(pIdx !== r.currentPlayerIndex) return socket.emit("error","Not your turn");
    const hand = r.hands[pid];
    if(!hand || cardIndex < 0 || cardIndex >= hand.length) return socket.emit("error","Invalid card index");

    // legal plays
    const allowed = legalPlayIndices(hand, r.tricks, r.trump);
    if(!allowed.includes(cardIndex)) return socket.emit("error","Illegal play according to rules");

    const played = hand.splice(cardIndex,1)[0];
    // belote detection: if player had both K & Q of trump at start and second of the pair played now => award 20 points
    if(r.beloteCandidates && r.beloteCandidates[pid] && r.beloteCandidates[pid].hasBoth){
      // if this is K or Q of trump and not yet declared, we mark first play; when second is played award points
      const bc = r.beloteCandidates[pid];
      if(played.suit === r.trump && (played.rank === "K" || played.rank === "Q")){
        if(!bc.firstPlayed){
          bc.firstPlayed = played.rank; // store which was first
        } else if(!bc.declared && bc.firstPlayed && bc.firstPlayed !== played.rank){
          // second of pair played -> award 20 points
          const team = teamIndex(room, pid);
          r.scores[team] += 20;
          bc.declared = true;
          io.to(room).emit("beloteDeclared", { playerId: pid, team, scores: r.scores });
        }
      }
    }

    r.tricks.push({ player: pid, card: played });
    // notify all about played card
    io.to(room).emit("cardPlayed", { player: pid, card: played });
    // send updated hand to the player who played (so it disappears immediately)
    io.to(pid).emit("hand", r.hands[pid]);

    // advance turn
    r.currentPlayerIndex = (r.currentPlayerIndex + 1) % 4;
    io.to(room).emit("turn", r.currentPlayerIndex);

    // if trick complete: determine winner
    if(r.tricks.length === 4){
      const lead = r.tricks[0].card.suit;
      let best = r.tricks[0];
      for(let i=1;i<4;i++){
        const c = r.tricks[i];
        if(compareCards(c.card, best.card, lead, r.trump) > 0) best = c;
      }
      const winnerId = best.player;
      const winnerIdx = r.players.findIndex(p=>p.id===winnerId);
      const team = teamIndex(room, winnerId);
      const pts = trickPoints(r.tricks, r.trump);
      r.scores[team] += pts;
      r.trickHistory.push({ winner: winnerId, points: pts, cards: r.tricks });
      r.tricks = [];
      // set next current player
      r.currentPlayerIndex = winnerIdx;
      io.to(room).emit("trickWinner", { winner: winnerId, scores: r.scores });
      // send updated hands to all players
      r.players.forEach(p => io.to(p.id).emit("hand", r.hands[p.id]));
      // check end of round: all hands empty
      const empty = r.players.every(p => (r.hands[p.id] || []).length === 0);
      if(empty){
        io.to(room).emit("roundEnd", { scores: r.scores, trickHistory: r.trickHistory });
        // rotate dealer automatically for next round; ask to confirm dealer
        r.phase = "chooseDealer";
        r.dealerIndex = (r.dealerIndex + 1) % 4;
        io.to(room).emit("chooseDealer", { players: r.players.map(p=>({id:p.id,name:p.name})), suggestedDealer: r.players[r.dealerIndex].id });
      }
    }
  });

  socket.on("disconnect", () => {
    for(const rm in rooms){
      const r = rooms[rm];
      r.players = r.players.filter(p=>p.id !== socket.id);
      io.to(rm).emit("players", r.players.map(p=>({id:p.id,name:p.name})));
    }
  });

}); // end connection

server.listen(PORT, ()=> console.log("Belote server listening on", PORT));
