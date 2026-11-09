// Scribble Squad game engine.
// It runs in the HOST player's browser: it keeps the secret word, runs the timers and scores
// guesses, then broadcasts the results to everyone through Supabase Realtime.
(() => {
  const AVATARS = ['🐸', '🦊', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🦖', '👽', '🤖', '👻', '🐢', '🦁', '🐨', '🐝'];
  const CHOOSE_TIME = 15;
  const TURN_END_TIME = 6;
  const MAX_PLAYERS = 16;
  const MAX_OPS = 6000;

  const clean = (s) => String(s || '').replace(/[\u0000-\u001f]/g, '').trim();
  const normalize = (s) => clean(s).toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();

  function levenshtein(a, b) {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
    }
    return dp[a.length][b.length];
  }

  const DIFFICULTIES = ['easy', 'normal', 'medium', 'hard'];
  function pickWords(n, difficulty) {
    const bank = window.WORDS[difficulty] || window.WORDS.normal;
    const pool = [...new Set(bank)];
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    return out;
  }

  class HostEngine {
    // send(event, payload) broadcasts to the room. `prior` is the last public state when taking over from a host who left.
    constructor({ code, hostId, send }) {
      this.code = code;
      this.hostId = hostId;
      this.send = send;
      this.online = new Set([hostId]);
      this.players = new Map();
      this.settings = { rounds: 3, drawTime: 80, difficulty: 'normal' };
      this.phase = 'lobby';
      this.round = 0;
      this.queue = [];
      this.drawerId = null;
      this.word = null;
      this.choices = [];
      this.revealed = new Set();
      this.guessed = new Set();
      this.turnPoints = {};
      this.turnId = 0;
      this.ops = [];
      this.endsAt = 0;
      this.timers = [];
      this.lastWord = null;
      this.leaderboard = null;
      this.lastGuess = new Map();
      this.banned = new Set(); // player ids (and account ids) the host kicked
    }

    // ---------- taking over from a host who left ----------
    adopt(s) {
      this.settings = { difficulty: 'normal', ...s.settings };
      this.round = s.round || 0;
      this.queue = Array.isArray(s.queue) ? [...s.queue] : [];
      this.turnId = (s.turnId || 0) + 1;
      for (const b of s.banned || []) this.banned.add(b);
      for (const p of s.players || []) {
        this.players.set(p.id, { id: p.id, name: p.name, avatar: p.avatar, uid: p.uid || null, pv: p.pv || 0, score: p.score || 0 });
        if (p.online) this.online.add(p.id); // assume they're still here; presence corrects it after the grace period
      }
      if (s.phase === 'lobby' || s.phase === 'gameOver') {
        this.phase = s.phase;
        this.leaderboard = s.leaderboard || null;
        this.broadcast();
      } else {
        this.chat({ kind: 'info', text: s.handoff ? 'The host changed, so this turn was skipped.' : 'The host reconnected, so this turn was skipped.' });
        // Show the turn-over screen briefly so everyone has time to reconnect.
        this.phase = 'turnEnd';
        this.lastWord = '…';
        this.turnPoints = {};
        this.endsAt = Date.now() + 4000;
        this.later(4, () => this.nextTurn());
        this.broadcast();
      }
    }

    destroy() {
      this.clearTimers();
    }

    // ---------- helpers ----------
    clearTimers() {
      this.timers.forEach(clearTimeout);
      this.timers = [];
    }
    later(sec, fn) {
      this.timers.push(setTimeout(fn, sec * 1000));
    }
    connected() {
      return [...this.players.values()].filter((p) => this.online.has(p.id));
    }
    // Chat lines from the same moment go out as one message so they arrive in order.
    chat(msg, to) {
      this.pendingChat = this.pendingChat || [];
      this.pendingChat.push(to ? { ...msg, to } : msg);
      if (this.chatQueued) return;
      this.chatQueued = true;
      queueMicrotask(() => {
        this.chatQueued = false;
        const items = this.pendingChat;
        this.pendingChat = [];
        this.send('chat', { items, turnId: this.turnId });
      });
    }
    hint() {
      if (!this.word) return null;
      return [...this.word].map((ch, i) => (ch === ' ' || ch === '-' ? ch : this.revealed.has(i) ? ch : '_')).join('');
    }

    publicState() {
      return {
        code: this.code,
        hostId: this.hostId,
        settings: this.settings,
        phase: this.phase,
        round: this.round,
        queue: this.queue,
        turnId: this.turnId,
        drawerId: this.drawerId,
        hint: this.phase === 'drawing' ? this.hint() : null,
        wordLength: this.word ? this.word.length : 0,
        endsAt: this.endsAt,
        hostNow: Date.now(),
        banned: [...this.banned],
        lastWord: this.phase === 'turnEnd' ? this.lastWord : null,
        turnPoints: this.phase === 'turnEnd' ? this.turnPoints : null,
        leaderboard: this.phase === 'gameOver' ? this.leaderboard : null,
        players: [...this.players.values()].map((p) => ({
          id: p.id,
          name: p.name,
          avatar: p.avatar,
          uid: p.uid || null,
          pv: p.pv || 0,
          score: p.score,
          online: this.online.has(p.id),
          guessed: this.guessed.has(p.id),
        })),
      };
    }

    broadcast() {
      this.send('state', this.publicState());
    }

    // The word only goes to the drawer and people who already guessed it.
    sendSecret() {
      if (this.phase === 'choosing') {
        this.send('secret', { to: [this.drawerId], turnId: this.turnId, choices: this.choices });
      } else if (this.phase === 'drawing') {
        this.send('secret', { to: [this.drawerId, ...this.guessed], turnId: this.turnId, word: this.word });
      }
    }

    // ---------- events from players ----------
    // uid/pv point at a signed-in player's drawn avatar (account id + profile version).
    hello(id, name, uid, pv) {
      name = clean(name).slice(0, 16);
      if (!name || !/^[a-zA-Z0-9_-]{8,40}$/.test(id)) return;
      const acct = typeof uid === 'string' && /^[0-9a-f-]{36}$/i.test(uid) ? uid : null;
      const ver = acct && Number.isFinite(pv) ? pv : 0;
      if (this.banned.has(id) || (acct && this.banned.has(acct))) {
        return this.send('reject', { to: id, kicked: true, error: 'The host removed you from this game.' });
      }
      let p = this.players.get(id);
      if (!p) {
        if (this.players.size >= MAX_PLAYERS) return this.send('reject', { to: id, error: 'That game is full (16 players).' });
        const used = new Set([...this.players.values()].map((x) => x.avatar));
        const avatar = AVATARS.find((a) => !used.has(a)) || AVATARS[this.players.size % AVATARS.length];
        p = { id, name, avatar, score: 0 };
        this.players.set(id, p);
        if (id !== this.hostId) this.chat({ kind: 'info', text: `${name} joined! 👋` });
      } else {
        p.name = name;
      }
      p.uid = acct;
      p.pv = ver;
      this.online.add(id);
      this.broadcast();
      this.sendSecret();
      this.syncOps(id);
    }

    syncOps(to) {
      // Chunk the drawing so each message stays well under Supabase's payload limit.
      const chunk = 400;
      if (this.ops.length === 0) return this.send('sync', { to, turnId: this.turnId, ops: [], part: 0 });
      for (let i = 0; i < this.ops.length; i += chunk) {
        this.send('sync', { to, turnId: this.turnId, ops: this.ops.slice(i, i + chunk), part: i / chunk });
      }
    }

    // Presence tells us who still has the page open.
    // People get a few seconds of grace so a page refresh or Wi-Fi blip doesn't kick them.
    setOnline(ids) {
      this.present = new Set(ids);
      this.present.add(this.hostId);
      let changed = false;
      for (const id of this.present) {
        if (!this.online.has(id) && this.players.has(id)) {
          this.online.add(id);
          changed = true;
        }
      }
      for (const id of this.online) {
        if (this.present.has(id)) continue;
        setTimeout(() => {
          if (this.present.has(id) || !this.online.has(id)) return;
          this.online.delete(id);
          this.onLeave(id);
        }, 5000);
      }
      if (changed) this.broadcast();
    }

    onLeave(id) {
      const p = this.players.get(id);
      if (!p) return;
      if (this.phase === 'lobby') this.players.delete(id);
      this.chat({ kind: 'info', text: `${p.name} left.` });
      const live = this.connected();
      if (this.phase !== 'lobby' && this.phase !== 'gameOver') {
        if (live.length < 2) return this.endGame('Not enough players left.');
        if (this.drawerId === id) return this.phase === 'choosing' ? this.nextTurn() : this.endTurn('left');
        if (this.phase === 'drawing' && this.everyoneGuessed()) return this.endTurn('all');
      }
      this.broadcast();
    }

    act(from, type, data) {
      if (!this.players.has(from)) return;
      const isHost = from === this.hostId;
      switch (type) {
        case 'settings': {
          if (!isHost || this.phase !== 'lobby') return;
          const rounds = Number(data?.rounds);
          const drawTime = Number(data?.drawTime);
          if ([1, 2, 3, 4, 5, 6, 8, 10].includes(rounds)) this.settings.rounds = rounds;
          if ([30, 45, 60, 80, 100, 120, 150].includes(drawTime)) this.settings.drawTime = drawTime;
          if (DIFFICULTIES.includes(data?.difficulty)) this.settings.difficulty = data.difficulty;
          return this.broadcast();
        }
        case 'start':
          if (!isHost || (this.phase !== 'lobby' && this.phase !== 'gameOver')) return;
          if (this.connected().length < 2) return this.chat({ kind: 'close', text: 'You need at least 2 players to start.' }, [from]);
          return this.startGame();
        case 'backToLobby':
          if (!isHost || this.phase !== 'gameOver') return;
          this.phase = 'lobby';
          for (const [id, p] of this.players) {
            p.score = 0;
            if (!this.online.has(id)) this.players.delete(id);
          }
          return this.broadcast();
        case 'choose':
          if (from !== this.drawerId || ![0, 1, 2].includes(data)) return;
          return this.chooseWord(data);
        case 'guess': {
          if (typeof data !== 'string') return;
          const now = Date.now();
          if (now - (this.lastGuess.get(from) || 0) < 300) return;
          this.lastGuess.set(from, now);
          return this.handleGuess(this.players.get(from), data);
        }
        case 'leave':
          this.online.delete(from);
          return this.onLeave(from);
        case 'kick':
          if (!isHost || data === this.hostId || !this.players.has(data)) return;
          return this.kick(data);
      }
    }

    // The host removes someone: they're dropped from the game and can't rejoin it.
    kick(id) {
      const p = this.players.get(id);
      this.banned.add(id);
      if (p.uid) this.banned.add(p.uid);
      this.players.delete(id);
      this.online.delete(id);
      this.guessed.delete(id);
      this.queue = this.queue.filter((q) => q !== id);
      this.send('reject', { to: id, kicked: true, error: 'The host removed you from this game.' });
      this.chat({ kind: 'info', text: `${p.name} was kicked by the host.` });
      if (this.phase !== 'lobby' && this.phase !== 'gameOver') {
        if (this.connected().length < 2) return this.endGame('Not enough players left.');
        if (this.drawerId === id) return this.phase === 'choosing' ? this.nextTurn() : this.endTurn('kicked');
        if (this.phase === 'drawing' && this.everyoneGuessed()) return this.endTurn('all');
      }
      this.broadcast();
    }

    // Drawing ops are broadcast by the drawer directly; the host just keeps a copy for late joiners.
    drawOps(from, ops) {
      if (from !== this.drawerId || this.phase !== 'drawing' || !Array.isArray(ops)) return;
      for (const op of ops) {
        if (op.t === 'undo') {
          const last = this.ops.length ? this.ops[this.ops.length - 1].id : null;
          if (last !== null) this.ops = this.ops.filter((o) => o.id !== last);
        } else if (op.t === 'clear') {
          this.ops = [];
        } else if (this.ops.length < MAX_OPS) {
          this.ops.push(op);
        }
      }
    }

    // ---------- turn flow ----------
    startGame() {
      this.clearTimers();
      for (const p of this.players.values()) p.score = 0;
      this.round = 0;
      this.queue = [];
      this.leaderboard = null;
      this.chat({ kind: 'good', text: '🎨 Game on! Guess the drawing in the chat.' });
      this.nextTurn();
    }

    nextTurn() {
      this.clearTimers();
      this.turnId += 1;
      this.guessed = new Set();
      this.turnPoints = {};
      this.revealed = new Set();
      this.word = null;
      this.ops = [];

      this.queue = this.queue.filter((id) => this.online.has(id) && this.players.has(id));
      if (this.queue.length === 0) {
        this.round += 1;
        if (this.round > this.settings.rounds) return this.endGame();
        this.queue = this.connected().map((p) => p.id);
        this.chat({ kind: 'round', text: `— Round ${this.round} of ${this.settings.rounds} —` });
      }
      if (this.connected().length < 2) return this.endGame('Not enough players left.');

      this.drawerId = this.queue.shift();
      this.choices = pickWords(3, this.settings.difficulty);
      this.phase = 'choosing';
      this.endsAt = Date.now() + CHOOSE_TIME * 1000;
      const turn = this.turnId;
      this.later(CHOOSE_TIME, () => turn === this.turnId && this.chooseWord(Math.floor(Math.random() * 3)));
      this.broadcast();
      this.sendSecret();
    }

    chooseWord(index) {
      if (this.phase !== 'choosing') return;
      this.clearTimers();
      this.word = this.choices[index] || this.choices[0];
      this.phase = 'drawing';
      const t = this.settings.drawTime;
      this.endsAt = Date.now() + t * 1000;
      const drawer = this.players.get(this.drawerId);
      this.chat({ kind: 'info', text: `${drawer?.name || 'Someone'} is drawing!` });

      const letterIdx = [...this.word].map((c, i) => (c === ' ' || c === '-' ? -1 : i)).filter((i) => i >= 0);
      const hintCount = Math.min(3, Math.max(0, Math.floor(letterIdx.length / 2) - 1));
      for (let h = 1; h <= hintCount; h++) {
        this.later(t * (0.35 + 0.5 * (h / (hintCount + 1))), () => {
          const hidden = letterIdx.filter((i) => !this.revealed.has(i));
          if (hidden.length > 1) {
            this.revealed.add(hidden[Math.floor(Math.random() * hidden.length)]);
            this.broadcast();
          }
        });
      }
      this.later(t, () => this.endTurn('time'));
      this.broadcast();
      this.sendSecret();
    }

    everyoneGuessed() {
      const guessers = this.connected().filter((p) => p.id !== this.drawerId);
      return guessers.length > 0 && guessers.every((p) => this.guessed.has(p.id));
    }

    endTurn(reason) {
      if (this.phase !== 'drawing' && this.phase !== 'choosing') return;
      this.clearTimers();
      this.lastWord = this.word || this.choices[0];
      this.phase = 'turnEnd';
      this.endsAt = Date.now() + TURN_END_TIME * 1000;
      if (reason === 'time') this.chat({ kind: 'info', text: `⏰ Time! The word was "${this.lastWord}".` });
      else if (reason === 'all') this.chat({ kind: 'good', text: `🎉 Everyone got it! The word was "${this.lastWord}".` });
      else if (reason === 'kicked') this.chat({ kind: 'info', text: `The drawer was kicked. The word was "${this.lastWord}".` });
      else if (reason === 'left') this.chat({ kind: 'info', text: `The drawer left. The word was "${this.lastWord}".` });
      this.later(TURN_END_TIME, () => this.nextTurn());
      this.broadcast();
    }

    endGame(note) {
      this.clearTimers();
      this.phase = 'gameOver';
      this.drawerId = null;
      this.word = null;
      const ranked = [...this.players.values()]
        .filter((p) => p.score > 0 || this.online.has(p.id))
        .sort((a, b) => b.score - a.score);
      let rank = 0;
      let prev = null;
      this.leaderboard = ranked.map((p, i) => {
        if (p.score !== prev) rank = i + 1;
        prev = p.score;
        return { id: p.id, name: p.name, avatar: p.avatar, uid: p.uid || null, pv: p.pv || 0, score: p.score, rank };
      });
      if (note) this.chat({ kind: 'info', text: note });
      this.chat({ kind: 'good', text: '🏆 Game over! Check the leaderboard.' });
      this.broadcast();
    }

    handleGuess(player, text) {
      const guess = normalize(text);
      if (!guess || !player) return;
      const answer = normalize(this.word);
      const canGuess = this.phase === 'drawing' && player.id !== this.drawerId && !this.guessed.has(player.id);

      if (canGuess && guess === answer) {
        const t = this.settings.drawTime;
        const left = Math.max(0, (this.endsAt - Date.now()) / 1000);
        const orderBonus = Math.max(0, 50 - this.guessed.size * 15);
        const pts = Math.round(50 + 400 * (left / t) + orderBonus);
        this.guessed.add(player.id);
        player.score += pts;
        this.turnPoints[player.id] = (this.turnPoints[player.id] || 0) + pts;
        const drawer = this.players.get(this.drawerId);
        if (drawer) {
          const dPts = Math.round(pts * 0.3);
          drawer.score += dPts;
          this.turnPoints[drawer.id] = (this.turnPoints[drawer.id] || 0) + dPts;
        }
        this.chat({ kind: 'good', text: `✅ ${player.name} guessed it! (+${pts})` });
        if (this.everyoneGuessed()) return this.endTurn('all');
        this.broadcast();
        this.sendSecret();
        return;
      }

      const msg = { kind: 'chat', pid: player.id, name: player.name, avatar: player.avatar, text: clean(text).slice(0, 100) };
      const inTheKnow = this.phase === 'drawing' && (player.id === this.drawerId || this.guessed.has(player.id));
      if (inTheKnow) return this.chat({ ...msg, kind: 'secret' }, [this.drawerId, ...this.guessed]);

      this.chat(msg);
      if (canGuess && answer.length >= 4 && levenshtein(guess, answer) === 1) {
        this.chat({ kind: 'close', text: `"${msg.text}" is so close!` }, [player.id]);
      }
    }
  }

  window.HostEngine = HostEngine;
})();
