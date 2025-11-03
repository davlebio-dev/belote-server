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

// Cartes
const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["7","8","9","J","Q","K","10","A"];

// Valeur en points selon l’atout
const pointAtout = { "7":0, "8":0, "9":14, "J":20, "Q":3, "K":4, "10":10, "A":11 };
const pointNonAtout = { "7":0, "8":0, "9":0, "J":2, "Q":3, "K":4, "10":10, "A":11 };

// Utility pour mélanger
function shuffle(array){return array.sort(()=>Math.random()-0.5);}

// Création du deck
function createDeck(){ 
  const deck=[]; 
  for(let s of suits) for(let r of ranks) deck.push({suit:s, rank:r}); 
  return shuffle(deck);
}

let rooms = {};

io.on("connection", socket => {

  socket.on("join", ({room, name}) => {
    if(!rooms[room]) rooms[room]={players:[], hands:{}, deck:[], atout:null, turn:0, tricks:[], scores:[0,0]};
    const r = rooms[room];
    if(r.players.length>=4) return socket.emit("error","Salle pleine !");
    r.players.push({id:socket.id, name});
    socket.join(room);

    if(r.players.length===4){
      r.deck = createDeck();
      // Distribution initiale : 5 cartes chacun
      r.players.forEach((p,i)=>{
        r.hands[p.id] = r.deck.slice(i*5, i*5+5);
      });
      r.retournee = r.deck[20]; // carte retournée pour choisir l’atout
      io.to(room).emit("start", {
        hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),
        players: r.players.map(p=>({name:p.name, id:p.id})),
        retourne: r.retournee
      });
    }
    io.to(room).emit("players", r.players.map(p=>p.name));
  });

  socket.on("chooseTrump", ({room, suit})=>{
    const r = rooms[room];
    if(!r) return;
    r.atout = suit;
    // Distribution des 3 cartes restantes
    r.players.forEach((p,i)=>{
      r.hands[p.id].push(...r.deck.slice(5*4 + i*3, 5*4 + i*3 + 3));
    });
    io.to(room).emit("trumpChosen", {atout: r.atout, hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])), turn:r.turn});
  });

  socket.on("play", ({room, cardIndex})=>{
    const r = rooms[room]; if(!r) return;
    const playerId = socket.id;
    const hand = r.hands[playerId];
    if(!hand || !hand[cardIndex]) return;

    const playedCard = hand.splice(cardIndex,1)[0];
    r.tricks.push({player:playerId, card:playedCard});
    io.to(room).emit("cardPlayed",{player:playerId, card:playedCard});

    r.turn = (r.turn+1)%4;

    if(r.tricks.length===4){
      // Déterminer le gagnant du pli selon Belote (atout et couleur demandée)
      const firstSuit = r.tricks[0].card.suit;
      let bestCard = r.tricks[0];
      for(let i=1;i<4;i++){
        const c = r.tricks[i];
        // Si même couleur et plus fort
        if(c.card.suit===firstSuit && ranks.indexOf(c.card.rank) > ranks.indexOf(bestCard.card.rank) && c.card.suit!==r.atout) bestCard=c;
        // Si atout
        if(c.card.suit===r.atout && bestCard.card.suit!==r.atout) bestCard=c;
        if(c.card.suit===r.atout && bestCard.card.suit===r.atout && ranks.indexOf(c.card.rank)>ranks.indexOf(bestCard.card.rank)) bestCard=c;
      }
      const winnerId = bestCard.player;
      const team = [0,2].includes(r.players.findIndex(p=>p.id===winnerId))?0:1;
      const pointsThisTrick = r.tricks.reduce((sum,t)=>{
        const pts = t.card.suit===r.atout?pointAtout[t.card.rank]:pointNonAtout[t.card.rank];
        return sum+pts;
      },0);
      r.scores[team]+=pointsThisTrick;
      r.tricks=[];
      io.to(room).emit("trickWinner",{winner:winnerId,scores:r.scores});
    }

    io.to(room).emit("turn",r.turn);
  });

  socket.on("disconnect", ()=>{
    for(const rName in rooms){
      rooms[rName].players = rooms[rName].players.filter(p=>p.id!==socket.id);
    }
  });

});

server.listen(PORT,()=>console.log("🚀 Serveur Belote complet sur port",PORT));
