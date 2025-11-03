import express from "express";
import http from "http";
import { Server } from "socket.io";

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3001;

const suits = ["♠", "♥", "♦", "♣"];
const ranks = ["7", "8", "9", "J", "Q", "K", "10", "A"];

function deck() {
  const d = [];
  for (let s of suits) for (let r of ranks) d.push(r + s);
  return d.sort(() => Math.random() - 0.5);
}

let rooms = {};

io.on("connection", (socket) => {
  socket.on("join", ({ room, name }) => {
    if (!rooms[room]) rooms[room] = { players: [], deck: deck(), hands: {} };
    const r = rooms[room];
    if (r.players.length >= 4) return socket.emit("error", "Salle pleine !");
    r.players.push({ id: socket.id, name });
    socket.join(room);

    if (r.players.length === 4) {
      r.players.forEach((p, i) => {
        r.hands[p.id] = r.deck.slice(i * 8, i * 8 + 8);
        io.to(p.id).emit("start", { hand: r.hands[p.id], room });
      });
      io.to(room).emit("message", "La partie commence !");
    }

    io.to(room).emit("players", r.players.map((p) => p.name));
  });

  socket.on("play", ({ room, card }) => {
    io.to(room).emit("cardPlayed", { player: socket.id, card });
  });

  socket.on("disconnect", () => {
    for (const r in rooms)
      rooms[r].players = rooms[r].players.filter((p) => p.id !== socket.id);
  });
});

server.listen(PORT, () => console.log("✅ Serveur belote en ligne sur port", PORT));
