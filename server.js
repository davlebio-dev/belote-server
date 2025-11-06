import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"], credentials: true },
  transports: ["websocket","polling"]
});

const PORT = process.env.PORT || 3001;

// Cartes et points
const suits = ["♠","♥","♦","♣"];
const ranks = ["7","8","9","J","Q","K","10","A"];
const pointsAtout = { "7":0,"8":0,"9":14,"J":20,"Q":3,"K":4,"10":10,"A":11 };
const pointsNormal = { "7":0,"8":0,"9":0,"J":2,"Q":3,"K":4,"10":10,"A":11 };

// Utils
function shuffle(deck){ return deck.sort(()=>Math.random()-0.5); }
function createDeck(){ 
  const deck=[]; 
  for(let s of suits) for(let r of ranks) deck.push({suit:s,rank:r}); 
  return shuffle(deck);
}

let rooms = {};

io.on("connection", socket=>{

  socket.on("join", ({room,name})=>{
    if(!rooms[room]) rooms[room]={players:[],hands:{},deck:[],turnedCard:null,phase:"teamSelection",teams:null,currentTurn:0,tricks:[],scores:[0,0]};
    const r = rooms[room];
    if(r.players.length>=4) return socket.emit("error","Salle pleine !");
    r.players.push({id:socket.id,name});
    socket.join(room);

    io.to(room).emit("players", r.players.map(p=>({id:p.id,name:p.name})));

    // Si 4 joueurs, demander le choix des équipes
    if(r.players.length===4){
      io.to(room).emit("chooseTeams", r.players.map(p=>({id:p.id,name:p.name})));
    }
  });

 socket.on("setTeams", ({room,teamA,teamB})=>{
  const r = rooms[room]; if(!r) return;
  // stocker les ids des équipes comme avant
  r.teams = { teamA, teamB };
  r.phase = "choixAtout";
  r.phaseAtoutTour = 1; // s'assurer que le 1er tour est actif

  // -> ENVOI teamsSet : on envoie la composition complète (id + name) aux clients
  io.to(room).emit("teamsSet", {
    teamA: r.players.filter(p => teamA.includes(p.id)).map(p => ({ id: p.id, name: p.name })),
    teamB: r.players.filter(p => teamB.includes(p.id)).map(p => ({ id: p.id, name: p.name }))
  });

  // Créer et distribuer le deck
  r.deck = createDeck();
  r.players.forEach((p,i)=> r.hands[p.id] = r.deck.slice(i*5,i*5+5));
  r.turnedCard = r.deck[20];

  // envoyer mains privées puis start (si tu préfères tu peux envoyer start après teamsSet)
  r.players.forEach(p => io.to(p.id).emit("hand", r.hands[p.id]));

  io.to(room).emit("start", {
    hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),
    turnedCard: r.turnedCard,
    teams: r.teams,
    currentTurn: 0
  });
});


// ---- Remplacement robuste du handler "bid" ----
socket.on("bid", ({room, take, color}) => {
  const r = rooms[room];
  if(!r) return;
  // sécurité
  if(r.phase !== "choixAtout" && r.phase !== "jeu") {
    return socket.emit("error", "Enchères non disponibles");
  }

  const actorId = socket.id;

  // Si le joueur passe
  if(!take){
    // on avance le tour
    r.currentTurn = (r.currentTurn + 1) % 4;

    // Emission pour informer tout le monde que ce joueur a passé et quel est le prochain
    io.to(room).emit("nextBid", {
      type: "pass",
      playerId: actorId,
      nextTurn: r.currentTurn,
      tour: r.phaseAtoutTour,
      turnedCard: r.turnedCard
    });

    // Si on a complété un tour complet au 1er tour -> passer au 2e tour
    // On considère qu'un "tour complet" revient au joueur qui a commencé l'enchère (ici initial currentTurn)
    if(r.phaseAtoutTour === 1){
      // détection simple : si r.bidStartIndex exists use it; else set it when first bid round starts
      if(typeof r.bidStartIndex === "undefined") r.bidStartIndex = (r.dealerIndex + 1) % 4;
      // si nextTurn equals bidStartIndex => tour complet
      if(r.currentTurn === r.bidStartIndex){
        r.phaseAtoutTour = 2;
        // notify second round start
        io.to(room).emit("nextBid", {
          type: "tour2start",
          playerId: null,
          nextTurn: r.currentTurn,
          tour: 2,
          turnedCard: r.turnedCard
        });
      }
    } else if(r.phaseAtoutTour === 2){
      // second tour: if full round completed -> redeal
      if(typeof r.bidStartIndex === "undefined") r.bidStartIndex = (r.dealerIndex + 1) % 4;
      if(r.currentTurn === r.bidStartIndex){
        // redeal
        r.deck = createDeck();
        r.players.forEach((p,i)=> r.hands[p.id] = r.deck.slice(i*5,i*5+5));
        r.turnedCard = r.deck[20];
        r.phaseAtoutTour = 1;
        // clear bidStartIndex for next time
        delete r.bidStartIndex;
        io.to(room).emit("redeal", {
          reason: "nobody_took",
          hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),
          turnedCard: r.turnedCard
        });
      }
    }

    return;
  }

  // Si le joueur prend (take === true)
  // contrôles sur le tour
  if(r.phaseAtoutTour === 1){
    // n'autorise que la couleur retournée
    if(color !== r.turnedCard.suit){
      socket.emit("error","Au premier tour vous ne pouvez prendre que la couleur retournée");
      return;
    }
  } else if(r.phaseAtoutTour === 2){
    if(color === r.turnedCard.suit){
      socket.emit("error","Au second tour vous ne pouvez pas choisir la couleur retournée");
      return;
    }
  }

  // Acceptation : définir l'atout et passer en jeu
  r.trump = color;
  r.phase = "jeu";
  // distribuer les 3 cartes restantes
  r.players.forEach((p,i)=> r.hands[p.id].push(...r.deck.slice(20+i*3,20+i*3+3)));

  // préparer belote detection (facultatif)
  r.beloteCandidates = {};
  r.players.forEach(p=>{
    const h = r.hands[p.id] || [];
    const hasK = h.some(c => c.suit === r.trump && c.rank === "K");
    const hasQ = h.some(c => c.suit === r.trump && c.rank === "Q");
    r.beloteCandidates[p.id] = { hasBoth: hasK && hasQ, declared:false, firstPlayed:null };
  });

  // informer la salle que l'atout a été choisi
  io.to(room).emit("trumpChosen", {
    playerId: actorId,
    trump: r.trump,
    hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]]))
  });

  // débuter le jeu : set current player (le joueur après le donneur)
  r.currentTurn = (r.dealerIndex + 1) % 4;
  io.to(room).emit("turn", r.currentTurn);
});



  socket.on("play", ({room,cardIndex})=>{
    const r = rooms[room]; if(!r||r.phase!=="jeu") return;
    const playerId = socket.id;
    const hand = r.hands[playerId]; if(!hand||!hand[cardIndex]) return;
    const playedCard = hand.splice(cardIndex,1)[0];
    r.tricks.push({player:playerId,card:playedCard});
    io.to(room).emit("cardPlayed",{player:playerId,card:playedCard});

    r.currentTurn=(r.currentTurn+1)%4;

    if(r.tricks.length===4){
      const firstSuit=r.tricks[0].card.suit;
      let bestCard=r.tricks[0];
      for(let i=1;i<4;i++){
        const c=r.tricks[i];
        if(c.card.suit===r.trump && bestCard.card.suit!==r.trump) bestCard=c;
        else if(c.card.suit===bestCard.card.suit){
          if(ranks.indexOf(c.card.rank)>ranks.indexOf(bestCard.card.rank)) bestCard=c;
        }
      }
      const winnerId=bestCard.player;
      const teamWinner=r.teams.teamA.includes(winnerId)?0:1;
      const pointsThisTrick=r.tricks.reduce((sum,t)=>{
        const pts=t.card.suit===r.trump?pointsAtout[t.card.rank]:pointsNormal[t.card.rank];
        return sum+pts;
      },0);
      r.scores[teamWinner]+=pointsThisTrick;
      r.tricks=[];
      io.to(room).emit("trickWinner",{winner:winnerId,scores:r.scores});
    }

    io.to(room).emit("turn",r.currentTurn);
  });

  socket.on("disconnect",()=>{
    for(const rName in rooms){
      rooms[rName].players = rooms[rName].players.filter(p=>p.id!==socket.id);
    }
  });

});

server.listen(PORT,()=>console.log("🚀 Serveur Belote avec équipes sur port",PORT));
