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
    r.teams={teamA,teamB};
    r.phase="choixAtout";

    // Créer et distribuer le deck
    r.deck=createDeck();
    r.players.forEach((p,i)=> r.hands[p.id] = r.deck.slice(i*5,i*5+5));
    r.turnedCard=r.deck[20];

    io.to(room).emit("start", {
      hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),
      turnedCard: r.turnedCard,
      teams: r.teams,
      currentTurn: 0
    });
  });

  socket.on("bid", ({room,take,color})=>{
    const r = rooms[room]; if(!r) return;
    const playerIndex = r.currentTurn;
    if(take){
      r.trump=color;
      r.phase="jeu";
      // Distribuer les 3 cartes restantes
      r.players.forEach((p,i)=> r.hands[p.id].push(...r.deck.slice(20+i*3,20+i*3+3)));
      io.to(room).emit("trumpChosen",{trump:color,hands:Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]]))});
    } else {
      r.currentTurn=(r.currentTurn+1)%4;
      io.to(room).emit("nextBid",{currentTurn:r.currentTurn});
    }
  });

  socket.on("play", ({room, cardIndex}) => {
  const r = rooms[room];
  if(!r || r.phase !== "jeu") return;
  const playerId = socket.id;
  const hand = r.hands[playerId];
  if(!hand || !hand[cardIndex]) return;
  const playedCard = hand.splice(cardIndex, 1)[0];

  // Envoie à tous que la carte a été jouée
  io.to(room).emit("cardPlayed", { player: playerId, card: playedCard });

  // <-- NOUVEAU : envoie la main mise à jour uniquement au joueur qui a joué -->
  io.to(playerId).emit("handUpdate", r.hands[playerId]);
  // <-- FIN NOUVEAU -->

  // logique du pli / changement de tour...
  r.tricks.push({ player: playerId, card: playedCard });
  r.currentTurn = (r.currentTurn + 1) % 4;
  // ... (calcul du gagnant quand r.tricks.length === 4, mise à jour scores etc.)
  io.to(room).emit("turn", r.currentTurn);
});
socket.on("requestHand", ({ room }) => {
  const r = rooms[room];
  if(!r) return;
  const hand = r.hands[socket.id] || [];
  io.to(socket.id).emit("handUpdate", hand);
});
  socket.on("disconnect",()=>{
    for(const rName in rooms){
      rooms[rName].players = rooms[rName].players.filter(p=>p.id!==socket.id);
    }
  });

});

server.listen(PORT,()=>console.log("🚀 Serveur Belote avec équipes sur port",PORT));
