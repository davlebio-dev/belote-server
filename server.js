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

// Cartes et points
const suits = ["♠","♥","♦","♣"];
const ranks = ["7","8","9","J","Q","K","10","A"];
const pointsAtout = { "7":0, "8":0, "9":14, "J":20, "Q":3, "K":4, "10":10, "A":11 };
const pointsNormal = { "7":0, "8":0, "9":0, "J":2, "Q":3, "K":4, "10":10, "A":11 };

function shuffle(deck){ return deck.sort(()=>Math.random()-0.5); }
function createDeck(){
  const deck=[];
  for(let s of suits) for(let r of ranks) deck.push({suit:s,rank:r});
  return shuffle(deck);
}

let rooms = {};

io.on("connection", socket=>{

  socket.on("join", ({room,name})=>{
    if(!rooms[room]) rooms[room]={players:[],hands:{},deck:[],turnedCard:null,phase:"choixAtout",trump:null,currentTurn:0,tricks:[],scores:[0,0],bidOrder:0};
    const r = rooms[room];
    if(r.players.length>=4) return socket.emit("error","Salle pleine !");
    r.players.push({id:socket.id,name});
    socket.join(room);

    if(r.players.length===4){
      r.deck = createDeck();
      // Distribution initiale 5 cartes
      r.players.forEach((p,i)=> r.hands[p.id] = r.deck.slice(i*5,i*5+5));
      r.turnedCard = r.deck[20]; // carte retournée pour atout
      io.to(room).emit("start",{
        hands: Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),
        players: r.players.map(p=>({name:p.name,id:p.id})),
        turnedCard: r.turnedCard,
        currentTurn: r.currentTurn
      });
    }
  });

  socket.on("bid", ({room,take,color})=>{
    const r = rooms[room]; if(!r) return;
    // Tour de prise
    const playerIndex = r.bidOrder % 4;
    if(take){
      r.trump=color;
      r.phase="jeu";
      // Distribuer les 3 cartes restantes
      r.players.forEach((p,i)=>{
        r.hands[p.id].push(...r.deck.slice(20+i*3,20+i*3+3));
      });
      io.to(room).emit("trumpChosen",{trump:color,hands:Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]]))});
    } else {
      r.bidOrder++;
      if(r.bidOrder>=8 && !r.trump){ 
        // personne n'a pris, redistribution
        r.deck=createDeck();
        r.players.forEach((p,i)=> r.hands[p.id] = r.deck.slice(i*5,i*5+5));
        r.turnedCard = r.deck[20];
        r.bidOrder=0;
        io.to(room).emit("redeal",{hands:Object.fromEntries(r.players.map(p=>[p.id,r.hands[p.id]])),turnedCard:r.turnedCard});
      } else {
        r.currentTurn = r.bidOrder%4;
        io.to(room).emit("nextBid",{currentTurn:r.currentTurn});
      }
    }
  });

  socket.on("play",({room,cardIndex})=>{
    const r = rooms[room]; if(!r || r.phase!=="jeu") return;
    const playerId=socket.id;
    const hand = r.hands[playerId];
    if(!hand||!hand[cardIndex]) return;
    const playedCard = hand.splice(cardIndex,1)[0];
    r.tricks.push({player:playerId,card:playedCard});
    io.to(room).emit("cardPlayed",{player:playerId,card:playedCard});
    r.currentTurn=(r.currentTurn+1)%4;

    if(r.tricks.length===4){
      // Détermination du gagnant du pli
      const firstSuit = r.tricks[0].card.suit;
      let bestCard = r.tricks[0];
      for(let i=1;i<4;i++){
        const c = r.tricks[i];
        if(c.card.suit===r.trump && bestCard.card.suit!==r.trump) bestCard=c;
        else if(c.card.suit===bestCard.card.suit){
          if(ranks.indexOf(c.card.rank) > ranks.indexOf(bestCard.card.rank)) bestCard=c;
        }
      }
      const winnerId=bestCard.player;
      const team=[0,2].includes(r.players.findIndex(p=>p.id===winnerId))?0:1;
      const pointsThisTrick=r.tricks.reduce((sum,t)=>{
        const pts = t.card.suit===r.trump?pointsAtout[t.card.rank]:pointsNormal[t.card.rank];
        return sum+pts;
      },0);
      r.scores[team]+=pointsThisTrick;
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

server.listen(PORT,()=>console.log("🚀 Serveur Belote classique sur port",PORT));
