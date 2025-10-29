// server.js - Run with: node server.js
// Install dependencies: npm install express socket.io

const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

app.use(express.static('public'));

// Game state
const games = new Map(); // roomId -> gameState

const SUITS = ["♠", "♣", "♥", "♦"];
const RANKS = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function buildDeckWithJoker() {
  const deck = [];
  for (const s of SUITS) {
    for (const r of RANKS) {
      deck.push({ 
        id: `${r}${s}`, 
        rank: r, 
        suit: s, 
        color: (s === "♥" || s === "♦") ? "red" : "black" 
      });
    }
  }
  deck.push({ id: "JK", rank: "JK", suit: "", color: "joker" });
  return deck;
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function dealAll(deck, nPlayers) {
  const hands = Array.from({ length: nPlayers }, () => []);
  let i = 0;
  while (deck.length) {
    hands[i % nPlayers].push(deck.pop());
    i++;
  }
  return hands;
}

function autoStockPairs(hand) {
  const groups = new Map();
  for (const c of hand) {
    const key = `${c.rank}-${c.color}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(c);
  }
  const toKeep = [];
  const newPairs = [];
  for (const [key, arr] of groups) {
    while (arr.length >= 2) {
      const a = arr.pop();
      const b = arr.pop();
      newPairs.push([a, b]);
    }
    if (arr.length === 1) toKeep.push(arr.pop());
  }
  return { hand: toKeep, pairs: newPairs };
}

function isGameOver(players) {
  const totalCards = players.reduce((acc, p) => acc + p.hand.length, 0);
  if (totalCards !== 1) return false;
  const holder = players.findIndex(p => p.hand.length === 1);
  const only = players[holder].hand[0];
  return only.id === "JK" ? holder : false;
}

function nextPlayerIndex(current, players) {
  let next = (current + 1) % players.length;
  while (players[next].hand.length === 0 && next !== current) {
    next = (next + 1) % players.length;
  }
  return next;
}

function getPublicGameState(game, playerId) {
  return {
    roomId: game.roomId,
    players: game.players.map((p, idx) => ({
      id: p.id,
      name: p.name,
      cardCount: p.hand.length,
      isMe: p.id === playerId,
      isCurrent: idx === game.currentPlayer
    })),
    stock: game.stock,
    currentPlayer: game.currentPlayer,
    started: game.started,
    gameOver: game.gameOver,
    loser: game.loser
  };
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('create-room', ({ playerName }) => {
    const roomId = Math.random().toString(36).substring(2, 8).toUpperCase();
    const game = {
      roomId,
      host: socket.id,
      players: [{
        id: socket.id,
        name: playerName || 'Player 1',
        hand: []
      }],
      stock: [],
      currentPlayer: 0,
      started: false,
      gameOver: false,
      loser: null
    };
    
    games.set(roomId, game);
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    
    socket.emit('room-created', { roomId });
    io.to(roomId).emit('game-state', getPublicGameState(game, socket.id));
  });

  socket.on('join-room', ({ roomId, playerName }) => {
    const game = games.get(roomId);
    
    if (!game) {
      socket.emit('error', { message: 'Room not found' });
      return;
    }
    
    if (game.started) {
      socket.emit('error', { message: 'Game already started' });
      return;
    }
    
    if (game.players.length >= 8) {
      socket.emit('error', { message: 'Room is full' });
      return;
    }
    
    game.players.push({
      id: socket.id,
      name: playerName || `Player ${game.players.length + 1}`,
      hand: []
    });
    
    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.playerName = playerName;
    
    socket.emit('room-joined', { roomId });
    io.to(roomId).emit('game-state', getPublicGameState(game, socket.id));
  });

  socket.on('start-game', () => {
    const roomId = socket.data.roomId;
    const game = games.get(roomId);
    
    if (!game || game.host !== socket.id) return;
    if (game.players.length < 2) {
      socket.emit('error', { message: 'Need at least 2 players' });
      return;
    }
    
    // Shuffle and deal
    const deck = shuffle(buildDeckWithJoker());
    const hands = dealAll(deck, game.players.length);
    
    game.players.forEach((player, idx) => {
      player.hand = hands[idx];
      const result = autoStockPairs(player.hand);
      player.hand = result.hand;
      game.stock.push(...result.pairs);
    });
    
    // Find first player with cards
    let current = 0;
    while (game.players[current].hand.length === 0) {
      current = (current + 1) % game.players.length;
    }
    game.currentPlayer = current;
    game.started = true;
    
    // Send state to all players
    game.players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('game-state', getPublicGameState(game, player.id));
        playerSocket.emit('your-hand', { hand: player.hand });
      }
    });
  });

  socket.on('auto-pair', () => {
    const roomId = socket.data.roomId;
    const game = games.get(roomId);
    
    if (!game || !game.started) return;
    
    const playerIdx = game.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== game.currentPlayer) return;
    
    const player = game.players[playerIdx];
    const result = autoStockPairs(player.hand);
    player.hand = result.hand;
    game.stock.push(...result.pairs);
    
    socket.emit('your-hand', { hand: player.hand });
    io.to(roomId).emit('game-state', getPublicGameState(game, socket.id));
  });

  socket.on('give-card', ({ cardIndex }) => {
    const roomId = socket.data.roomId;
    const game = games.get(roomId);
    
    if (!game || !game.started || game.gameOver) return;
    
    const playerIdx = game.players.findIndex(p => p.id === socket.id);
    if (playerIdx !== game.currentPlayer) return;
    
    const currentPlayer = game.players[playerIdx];
    if (cardIndex < 0 || cardIndex >= currentPlayer.hand.length) return;
    
    // Remove card from current player
    const card = currentPlayer.hand.splice(cardIndex, 1)[0];
    
    // Give to next player
    const nextIdx = nextPlayerIndex(playerIdx, game.players);
    const nextPlayer = game.players[nextIdx];
    nextPlayer.hand.push(card);
    
    // Auto-stock pairs for recipient
    const result = autoStockPairs(nextPlayer.hand);
    nextPlayer.hand = result.hand;
    game.stock.push(...result.pairs);
    
    // Update current player
    game.currentPlayer = nextPlayerIndex(playerIdx, game.players);
    
    // Check game over
    const loserIdx = isGameOver(game.players);
    if (loserIdx !== false) {
      game.gameOver = true;
      game.loser = loserIdx;
    }
    
    // Broadcast state to all
    game.players.forEach(player => {
      const playerSocket = io.sockets.sockets.get(player.id);
      if (playerSocket) {
        playerSocket.emit('game-state', getPublicGameState(game, player.id));
        playerSocket.emit('your-hand', { hand: player.hand });
      }
    });
  });

  socket.on('disconnect', () => {
    console.log('Player disconnected:', socket.id);
    const roomId = socket.data.roomId;
    const game = games.get(roomId);
    
    if (game) {
      game.players = game.players.filter(p => p.id !== socket.id);
      
      if (game.players.length === 0) {
        games.delete(roomId);
      } else {
        io.to(roomId).emit('game-state', getPublicGameState(game, null));
        io.to(roomId).emit('player-left', { 
          message: `${socket.data.playerName} left the game` 
        });
      }
    }
  });

  // --- REAL-TIME CHAT HANDLING ---
socket.on('chat-message', ({ message }) => {
  const roomId = socket.data.roomId;
  const game = games.get(roomId);
  if (!game) return;

  // Lookup player name using socket.id
  const player = game.players.find(p => p.id === socket.id);
  const playerName = player ? player.name : 'Player';

  // Broadcast to all (except sender, for "You" message) in the room
  io.to(roomId).emit('chat-message', {
    playerName: playerName,
    message: message,
    isMe: false
  });

  // Echo to sender as "You"
  socket.emit('chat-message', {
    playerName: 'You',
    message: message,
    isMe: true
  });
});

});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});