// Scribble Squad — browser client (multiplayer over Supabase Realtime)
(() => {
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  // ---------- storage (wrapped: private windows can block it) ----------
  const local = (() => { try { return localStorage; } catch { return null; } })();
  const session = (() => { try { return sessionStorage; } catch { return null; } })();
  const store = {
    get(k, s = local) { try { return s ? s.getItem(k) : null; } catch { return null; } },
    set(k, v, s = local) { try { s && s.setItem(k, v); } catch {} },
    del(k, s = local) { try { s && s.removeItem(k); } catch {} },
  };

  // Each browser tab is its own player, so you can test with two tabs.
  let playerId = store.get('ss-player', session);
  if (!playerId || !/^[a-zA-Z0-9_-]{8,40}$/.test(playerId)) {
    playerId = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, '0')).join('');
    store.set('ss-player', playerId, session);
  }

  const CFG = window.SCRIBBLE_CONFIG;
  const sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseKey, {
    realtime: { params: { eventsPerSecond: 30 } },
  });

  const EVENTS = ['hello', 'act', 'state', 'secret', 'chat', 'sync', 'draw', 'reject', 'cur', 'handoff'];
  let channel = null;
  let engine = null; // only set on the host's browser
  let state = null;
  let secret = null;
  let myName = '';
  let currentCode = null;
  let clockOffset = 0;
  let lastPhaseKey = '';
  let qrFor = null;
  let joinWaiter = null;
  let takeoverTimer = null;
  let handoffTimer = null;
  let localOps = [];
  let lastTurnId = null;
  let account = { user: null, profile: null, pv: 0 }; // signed-in account, if any

  // ---------- drawn avatars ----------
  // Players with an account have a drawn avatar stored in Supabase; everyone else gets an emoji.
  const pics = new Map(); // account id -> { pv, url }
  const picQueue = new Map();
  let picTimer = null;
  let picsVersion = 0;

  function picUrl(p) {
    if (!p?.uid) return null;
    const c = pics.get(p.uid);
    if (!c || c.pv !== p.pv) {
      picQueue.set(p.uid, p.pv);
      clearTimeout(picTimer);
      picTimer = setTimeout(loadPics, 60);
    }
    return c?.url || null;
  }

  async function loadPics() {
    const want = new Map(picQueue);
    picQueue.clear();
    for (const [uid, pv] of want) pics.set(uid, { pv, url: pics.get(uid)?.url || null });
    const { data, error } = await sb.from('player_profiles').select('id, avatar').in('id', [...want.keys()]);
    if (error) return;
    for (const row of data || []) pics.set(row.id, { pv: want.get(row.id), url: row.avatar || null });
    picsVersion += 1;
    rerender();
  }

  function avatarNode(p, cls = 'av') {
    const wrapEl = el('span', cls);
    const url = picUrl(p);
    if (url) {
      const img = el('img', 'pic');
      img.src = url;
      img.alt = '';
      wrapEl.append(img);
    } else {
      wrapEl.textContent = p?.avatar || '🙂';
    }
    return wrapEl;
  }

  function rerender() {
    if (!state) return;
    if (state.phase === 'lobby') renderLobby();
    else renderGame(state);
  }

  // ---------- networking ----------
  function send(event, payload = {}) {
    if (!channel) return;
    channel.send({ type: 'broadcast', event, payload: { ...payload, from: playerId } });
  }
  const act = (type, data) => send('act', { type, data });
  const helloPayload = () => ({ name: myName, uid: account.user?.id || null, pv: account.pv || 0 });

  function openChannel(code) {
    return new Promise((resolve) => {
      let settled = false;
      const ch = sb.channel(`scribble:${code}`, {
        config: { broadcast: { self: true }, presence: { key: playerId } },
      });
      EVENTS.forEach((ev) => ch.on('broadcast', { event: ev }, ({ payload }) => onMessage(ev, payload)));
      ch.on('presence', { event: 'sync' }, onPresence);
      ch.subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await ch.track({ name: myName });
          if (!settled) { settled = true; resolve(ch); }
          else if (!engine) send('hello', helloPayload()); // reconnected after a network blip
        } else if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !settled) {
          settled = true;
          resolve(null);
        }
      });
    });
  }

  async function closeChannel() {
    engine?.destroy();
    engine = null;
    clearTimeout(takeoverTimer);
    clearTimeout(handoffTimer);
    if (channel) {
      const ch = channel;
      channel = null;
      try { await ch.untrack(); } catch {}
      try { await sb.removeChannel(ch); } catch {}
    }
  }

  function becomeHost(prior) {
    engine?.destroy();
    engine = new window.HostEngine({ code: currentCode, hostId: playerId, send });
    engine.online = new Set([playerId, ...Object.keys(channel.presenceState())]);
    if (prior) engine.adopt(prior);
    const h = helloPayload();
    engine.hello(playerId, h.name, h.uid, h.pv);
    if (prior?.handoff) engine.chat({ kind: 'good', text: `👑 ${h.name} is the host now.` });
    onPresence();
  }

  // The host hands the game to someone else: their browser starts running it from our latest state.
  function giveHost(p) {
    if (!engine || !state || p.id === playerId) return;
    const snapshot = { ...engine.publicState(), handoff: true };
    engine.destroy();
    engine = null;
    store.del('ss-state', session);
    send('handoff', { to: p.id, prior: snapshot });
    // If they never pick it up (closed the tab just now), take the game back.
    clearTimeout(handoffTimer);
    handoffTimer = setTimeout(() => {
      if (channel && state && state.hostId === playerId && !engine) {
        becomeHost(snapshot);
        toast(`${p.name} didn't pick it up, so you're still the host.`);
      }
    }, 5000);
  }

  function makeCode() {
    const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    return Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('');
  }

  async function createGame(name) {
    myName = name;
    for (let tries = 0; tries < 5; tries++) {
      const code = makeCode();
      currentCode = code;
      channel = await openChannel(code);
      if (!channel) return { error: "Couldn't connect. Check your internet and try again." };
      await new Promise((r) => setTimeout(r, 400));
      const others = Object.keys(channel.presenceState()).filter((k) => k !== playerId);
      if (others.length === 0) {
        becomeHost(null);
        return { code };
      }
      await closeChannel(); // code already in use, try another
    }
    return { error: 'Could not find a free code, try again.' };
  }

  async function joinGame(code, name) {
    myName = name;
    currentCode = code;
    channel = await openChannel(code);
    if (!channel) return { error: "Couldn't connect. Check your internet and try again." };

    // Host refreshed the page: pick the game back up from where it was.
    const saved = readSavedState(code);
    if (saved && saved.hostId === playerId) {
      await new Promise((r) => setTimeout(r, 1500)); // let presence show who's still here
      becomeHost(saved);
      return { code };
    }

    const result = await new Promise((resolve) => {
      joinWaiter = resolve;
      send('hello', helloPayload());
      setTimeout(() => resolve({ error: `No game found with code ${code}.` }), 6000);
    });
    joinWaiter = null;
    if (result.error) await closeChannel();
    return result;
  }

  function readSavedState(code) {
    try {
      const s = JSON.parse(store.get('ss-state', session) || 'null');
      return s && s.code === code ? s : null;
    } catch {
      return null;
    }
  }

  function onMessage(event, p) {
    if (!p || typeof p !== 'object') return;
    const from = p.from;
    switch (event) {
      case 'hello':
        if (engine) engine.hello(from, p.name, p.uid, p.pv);
        break;
      case 'act':
        if (engine) engine.act(from, p.type, p.data);
        break;
      case 'state':
        if (from !== p.hostId) return; // only the host may set the game state
        if (engine && from !== playerId) {
          // Someone else took over as host; step down.
          engine.destroy();
          engine = null;
        }
        if (!p.players?.some((x) => x.id === playerId)) return; // not in this game (yet)
        if (joinWaiter) joinWaiter({ code: p.code });
        applyState(p);
        break;
      case 'secret':
        if (Array.isArray(p.to) && p.to.includes(playerId)) {
          secret = p;
          if (state) renderGame(state);
        }
        break;
      case 'chat':
        if (from !== state?.hostId && !(engine && from === playerId)) return;
        if (typeof p.turnId === 'number') {
          if (p.turnId < chatTurn) return; // left over from an earlier turn
          resetChatFor(p.turnId);
        }
        for (const m of Array.isArray(p.items) ? p.items : []) {
          if (!Array.isArray(m.to) || m.to.includes(playerId)) addChat(m);
        }
        break;
      case 'sync':
        if (p.to !== playerId || !Array.isArray(p.ops)) return;
        if (p.part === 0) localOps = [];
        localOps.push(...p.ops);
        lastTurnId = p.turnId;
        redraw();
        break;
      case 'draw':
        if (engine) engine.drawOps(from, p.ops);
        if (from === playerId || !state || from !== state.drawerId || !Array.isArray(p.ops)) return;
        for (const op of p.ops) applyRemote(op);
        break;
      case 'reject':
        if (p.to !== playerId) return;
        if (joinWaiter) joinWaiter({ error: p.error });
        else if (p.kicked && currentCode) leaveRoom(p.error);
        break;
      case 'handoff':
        if (p.to !== playerId || !state || from !== state.hostId || engine || !p.prior) return;
        becomeHost({ ...p.prior, hostId: playerId, handoff: true });
        toast("You're the host now 👑");
        break;
      case 'cur':
        if (from !== playerId && state && from === state.drawerId && state.phase === 'drawing') moveCursor(from, p.x, p.y);
        break;
    }
  }

  function onPresence() {
    if (!channel) return;
    const ids = Object.keys(channel.presenceState());
    if (engine) return engine.setOnline(ids);

    // If the host disappears for a few seconds, the next player in line takes over.
    clearTimeout(takeoverTimer);
    if (!state || ids.includes(state.hostId)) return;
    takeoverTimer = setTimeout(() => {
      if (!channel || !state || engine) return;
      const now = Object.keys(channel.presenceState());
      if (now.includes(state.hostId)) return;
      const next = state.players.map((x) => x.id).filter((id) => now.includes(id)).sort()[0];
      if (next === playerId) becomeHost(state);
    }, 6000);
  }

  // ---------- home ----------
  const nameInput = $('nameInput');
  const codeInput = $('codeInput');
  nameInput.value = store.get('ss-name') || '';
  const urlRoom = new URLSearchParams(location.search).get('room');
  if (urlRoom) codeInput.value = urlRoom.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  codeInput.addEventListener('input', () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);
  });

  function needName() {
    const name = nameInput.value.trim().slice(0, 16);
    if (!name) {
      $('homeError').textContent = 'Type a name first!';
      nameInput.focus();
      return null;
    }
    store.set('ss-name', name); // pre-fills next time
    store.set('ss-name', name, session); // this tab's name, for rejoining
    return name;
  }

  let busy = false;
  async function enter(fn) {
    if (busy) return;
    busy = true;
    $('createBtn').disabled = $('joinBtn').disabled = true;
    const res = await fn();
    if (!res.error) $('homeError').textContent = '';
    busy = false;
    $('createBtn').disabled = $('joinBtn').disabled = false;
    if (res.error) {
      $('homeError').textContent = res.error;
      currentCode = null;
      store.del('ss-room', session);
      return;
    }
    store.set('ss-room', res.code, session);
    history.replaceState(null, '', `?room=${res.code}`);
  }

  $('createBtn').onclick = () => {
    const name = needName();
    if (name) enter(() => createGame(name));
  };
  const doJoin = () => {
    const name = needName();
    if (!name) return;
    const code = codeInput.value.trim();
    if (code.length !== 4) {
      $('homeError').textContent = 'Codes are 4 letters.';
      return codeInput.focus();
    }
    enter(() => joinGame(code, name));
  };
  $('joinBtn').onclick = doJoin;
  codeInput.addEventListener('keydown', (e) => e.key === 'Enter' && doJoin());
  nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && (codeInput.value.length === 4 ? doJoin() : $('createBtn').click()));

  // Refreshing the page drops you back into the same game.
  const resumeCode = store.get('ss-room', session);
  const resumeName = store.get('ss-name', session);
  if (resumeCode && resumeName) {
    codeInput.value = resumeCode;
    nameInput.value = resumeName;
    $('homeError').textContent = 'Rejoining…';
    enter(() => joinGame(resumeCode, resumeName));
  }

  // ---------- lobby ----------
  $('copyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText($('joinLink').value);
      toast('Link copied! Paste it in Discord 📋');
    } catch {
      $('joinLink').select();
      toast('Press Ctrl+C to copy');
    }
  };
  $('roundsSel').onchange = $('timeSel').onchange = () =>
    act('settings', { rounds: +$('roundsSel').value, drawTime: +$('timeSel').value });
  $('startBtn').onclick = () => act('start');
  $('leaveBtn').onclick = () => leaveRoom();

  // `kickedMsg` is set when the host removed us, so there's no goodbye to send.
  async function leaveRoom(kickedMsg) {
    if (!kickedMsg) {
      act('leave');
      await new Promise((r) => setTimeout(r, 150));
    }
    await closeChannel();
    currentCode = null;
    state = null;
    secret = null;
    lastPhaseKey = '';
    store.del('ss-room', session);
    store.del('ss-state', session);
    history.replaceState(null, '', location.pathname);
    $('chat').replaceChildren();
    chatTurn = -1;
    lastTurnId = null;
    show('home');
    $('homeError').textContent = kickedMsg || '';
  }

  // Hosts get 👑 (make host) and ✕ (kick) next to everyone else.
  function hostBtns(p) {
    if (!isHost() || p.id === playerId) return [];
    const crown = el('button', 'kick crown', '👑');
    crown.title = `Make ${p.name} the host`;
    crown.setAttribute('aria-label', crown.title);
    crown.disabled = !p.online;
    crown.onclick = (e) => {
      e.stopPropagation();
      const mid = state.phase !== 'lobby' && state.phase !== 'gameOver';
      if (confirm(`Make ${p.name} the host?${mid ? ' The current turn will be skipped.' : ''}`)) giveHost(p);
    };
    return [crown, kickBtn(p)];
  }

  function kickBtn(p) {
    const b = el('button', 'kick', '✕');
    b.title = `Kick ${p.name}`;
    b.setAttribute('aria-label', `Kick ${p.name}`);
    b.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Kick ${p.name} from the game? They won't be able to rejoin.`)) act('kick', p.id);
    };
    return b;
  }

  function loadQr(code) {
    if (qrFor === code) return;
    qrFor = code;
    const url = `${location.origin}${location.pathname}?room=${code}`;
    $('joinLink').value = url;
    try {
      const qr = window.qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      $('qrImg').src = qr.createDataURL(8, 2);
    } catch {}
    $('lanNote').textContent = /^(localhost|127\.)/.test(location.hostname)
      ? 'This is a localhost link. Share the public site link so friends can join.'
      : '';
  }

  // ---------- rendering ----------
  function show(id) {
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
  }

  function applyState(s) {
    const prev = state;
    state = s;
    clockOffset = s.hostNow - Date.now();
    store.set('ss-state', JSON.stringify(s), session);
    if (s.turnId !== lastTurnId) {
      lastTurnId = s.turnId;
      localOps = [];
      redraw();
    }
    if (secret && secret.turnId !== s.turnId) secret = null;
    resetChatFor(s.turnId);
    if (s.phase === 'lobby') {
      chat.replaceChildren(); // nothing carries over after a game
      show('lobby');
      renderLobby();
    } else {
      show('game');
      renderGame(prev);
    }
  }

  const me = () => state.players.find((p) => p.id === playerId);
  const isHost = () => state.hostId === playerId;
  const isDrawer = () => state && state.drawerId === playerId && state.phase === 'drawing';
  const myWord = () => (secret && secret.turnId === state.turnId ? secret.word : null);
  const myChoices = () => (secret && secret.turnId === state.turnId && state.drawerId === playerId ? secret.choices : null);

  function renderLobby() {
    $('lobbyCode').textContent = state.code;
    loadQr(state.code);
    $('lobbyPlayers').replaceChildren(
      ...state.players.map((p) => {
        const li = el('li');
        li.append(avatarNode(p), el('span', null, p.name));
        if (p.id === state.hostId) li.append(el('span', 'badge', 'host'));
        if (p.id === playerId) li.append(el('span', 'badge you', 'you'));
        li.append(...hostBtns(p));
        return li;
      })
    );
    $('playerCount').textContent = state.players.length;
    $('roundsSel').value = state.settings.rounds;
    $('timeSel').value = state.settings.drawTime;
    const host = isHost();
    $('hostSettings').style.display = host ? '' : 'none';
    $('startBtn').style.display = host ? '' : 'none';
    $('waitHost').style.display = host ? 'none' : '';
    const r = state.settings.rounds;
    $('settingsInfo').textContent = `${r} round${r === 1 ? '' : 's'} · ${state.settings.drawTime}s to draw`;
    const enough = state.players.filter((p) => p.online).length >= 2;
    $('startBtn').disabled = !enough;
    $('startBtn').textContent = enough ? '🚀 Start game' : 'Need 2+ players…';
  }

  function renderGame(prev) {
    if (state.phase === 'lobby') return;
    const rounds = state.settings.rounds;
    $('roundLabel').textContent = `Round ${Math.min(rounds, Math.max(1, state.round))}/${rounds}`;
    $('timer').style.visibility = state.phase === 'gameOver' ? 'hidden' : '';

    const w = $('wordLabel');
    w.replaceChildren();
    const word = myWord();
    if (state.phase === 'drawing') {
      if (word) {
        w.append(document.createTextNode(word.toUpperCase()));
        w.append(el('small', null, isDrawer() ? 'draw this!' : 'you got it!'));
      } else {
        w.append(document.createTextNode((state.hint || '').toUpperCase()));
        w.append(el('small', null, `${state.wordLength} letters`));
      }
    } else if (state.phase === 'choosing') {
      w.append(el('small', null, 'picking a word…'));
    }

    const ranked = [...state.players].sort((a, b) => b.score - a.score);
    $('gamePlayers').replaceChildren(
      ...ranked.map((p, i) => {
        const li = el('li');
        if (p.guessed) li.classList.add('guessed');
        if (p.id === state.drawerId && state.phase !== 'gameOver') li.classList.add('drawing');
        if (!p.online) li.classList.add('offline');
        li.append(el('span', 'rk', `#${i + 1}`), avatarNode(p));
        const info = el('div', 'info');
        info.append(el('span', 'nm', p.name + (p.id === playerId ? ' (you)' : '')), el('span', 'sc', `${p.score} pts`));
        li.append(info);
        if (p.id === state.drawerId && state.phase !== 'gameOver') li.append(el('span', 'pen', '✏️'));
        li.append(...hostBtns(p));
        return li;
      })
    );

    $('tools').classList.toggle('hidden', !isDrawer());
    $('canvasWrap').classList.toggle('locked', !isDrawer());
    hideOtherCursors();

    const gi = $('guessInput');
    if (isDrawer()) gi.placeholder = "You're drawing! Chat only reaches people who guessed.";
    else if (me()?.guessed && state.phase === 'drawing') gi.placeholder = 'You got it! 🤫 Chat with other winners…';
    else gi.placeholder = 'Type your guess…';

    if (prev && prev !== state && prev.players) {
      const youBefore = prev.players.find((p) => p.id === playerId);
      if (me()?.guessed && youBefore && !youBefore.guessed) { sfx.win(); confetti(40); }
      else if (state.phase === 'drawing' && state.players.some((p) => p.guessed && !prev.players.find((q) => q.id === p.id)?.guessed)) sfx.ding();
    }

    renderOverlay();
  }

  function renderOverlay() {
    const o = $('overlay');
    const choices = myChoices();
    const base = `${state.phase}|${state.turnId}|${state.hostId}|${choices ? 1 : 0}|${state.phase === 'turnEnd' ? JSON.stringify(state.turnPoints) : ''}`;
    const key = `${base}|${picsVersion}`;
    if (key === lastPhaseKey) return;
    const fresh = !lastPhaseKey.startsWith(base + '|'); // first time showing this screen (not just avatars loading)
    lastPhaseKey = key;
    o.replaceChildren();
    o.classList.remove('show');
    const drawer = state.players.find((p) => p.id === state.drawerId);

    if (state.phase === 'choosing') {
      o.classList.add('show');
      if (choices) {
        if (fresh) sfx.turn();
        o.append(el('h2', null, 'Your turn! Pick a word'));
        const c = el('div', 'choices');
        choices.forEach((word, i) => {
          const b = el('button', 'btn', word);
          b.onclick = () => act('choose', i);
          c.append(b);
        });
        o.append(c);
      } else {
        o.append(avatarNode(drawer, 'big-word'), el('h2', null, `${drawer?.name || 'Someone'} is choosing a word…`));
      }
    } else if (state.phase === 'turnEnd') {
      o.classList.add('show');
      if (state.lastWord === '…') return o.append(el('h2', null, '🔌 Host reconnected, next turn starting…'));
      o.append(el('p', null, 'The word was'), el('div', 'big-word', state.lastWord || '?'));
      const list = el('ul', 'turn-scores');
      const tp = state.turnPoints || {};
      const sorted = [...state.players].sort((a, b) => (tp[b.id] || 0) - (tp[a.id] || 0));
      for (const p of sorted) {
        const pts = tp[p.id] || 0;
        const li = el('li');
        const who = el('span');
        who.append(avatarNode(p, 'mini'), document.createTextNode(` ${p.name}`));
        li.append(who, el('span', pts ? 'plus' : 'zero', pts ? `+${pts}` : '0'));
        list.append(li);
      }
      o.append(list);
    } else if (state.phase === 'gameOver') {
      o.classList.add('show');
      renderLeaderboard(o, fresh);
    }
  }

  function renderLeaderboard(o, fresh) {
    const lb = state.leaderboard || [];
    if (fresh) {
      sfx.fanfare();
      confetti(120);
    }
    const winner = lb[0];
    const tied = lb.filter((p) => p.rank === 1).length > 1;
    let title = 'Game over';
    if (winner && winner.score === 0) title = 'Nobody scored… 😅';
    else if (winner && tied) title = "🏆 It's a tie!";
    else if (winner) title = `🏆 ${winner.name} wins!`;
    o.append(el('h2', null, title));
    const podium = el('div', 'podium');
    [lb[1], lb[0], lb[2]].forEach((p, i) => {
      if (!p) return;
      const place = [2, 1, 3][i];
      const step = el('div', `step p${place}`);
      if (p.id === playerId) step.classList.add('me');
      const av = el('div', 'av');
      av.append(avatarNode(p, 'face'));
      step.append(av, el('div', 'nm', p.name), el('div', 'pts', `${p.score} pts`), el('div', 'block', `${p.rank}`));
      podium.append(step);
    });
    o.append(podium);
    if (lb.length > 3) {
      const rest = el('ul', 'rest');
      lb.slice(3).forEach((p) => {
        const li = el('li');
        if (p.id === playerId) li.classList.add('me');
        const who = el('span');
        who.append(avatarNode(p, 'mini'), document.createTextNode(` ${p.name}`));
        li.append(el('span', null, `#${p.rank}`), who, el('span', 's', `${p.score}`));
        rest.append(li);
      });
      o.append(rest);
    }
    const btns = el('div', 'over-btns');
    if (isHost()) {
      const again = el('button', 'btn primary', '🔁 Play again');
      again.onclick = () => act('start');
      const lobby = el('button', 'btn', 'Back to lobby');
      lobby.onclick = () => act('backToLobby');
      btns.append(again, lobby);
    } else {
      btns.append(el('p', null, 'Waiting for the host to start another game…'));
    }
    const leave = el('button', 'btn ghost', 'Leave');
    leave.style.color = '#fff';
    leave.onclick = () => leaveRoom();
    btns.append(leave);
    o.append(btns);
  }

  // ---------- timer ----------
  let lastTick = null;
  setInterval(() => {
    if (!state || !['choosing', 'drawing', 'turnEnd'].includes(state.phase)) return;
    const left = Math.max(0, Math.ceil((state.endsAt - (Date.now() + clockOffset)) / 1000));
    $('timerNum').textContent = left;
    const total = state.phase === 'drawing' ? state.settings.drawTime : state.phase === 'choosing' ? 15 : 6;
    $('timer').style.setProperty('--p', `${Math.min(100, (left / total) * 100)}%`);
    const hurry = state.phase === 'drawing' && left <= 10;
    $('timer').classList.toggle('hurry', hurry);
    if (hurry && left !== lastTick && left > 0) sfx.tick();
    lastTick = left;
  }, 200);

  // ---------- chat ----------
  // Chat only lives for one turn: it's wiped when the next turn (or a new game) starts.
  const chat = $('chat');
  let chatTurn = -1;
  function resetChatFor(turnId) {
    if (turnId > chatTurn) {
      chatTurn = turnId;
      chat.replaceChildren();
    }
  }
  function addChat(m) {
    const kind = ['chat', 'secret', 'info', 'good', 'close', 'round'].includes(m.kind) ? m.kind : 'info';
    const div = el('div', `m k-${kind}`);
    if (kind === 'chat' || kind === 'secret') {
      const who = el('b');
      const p = state?.players.find((q) => q.id === m.pid) || { avatar: m.avatar };
      who.append(avatarNode(p, 'mini'), document.createTextNode(` ${m.name || ''}: `));
      div.append(who, document.createTextNode(String(m.text || '')));
    } else {
      div.textContent = String(m.text || '');
    }
    const atBottom = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 40;
    chat.append(div);
    while (chat.children.length > 150) chat.firstChild.remove();
    if (atBottom) chat.scrollTop = chat.scrollHeight;
  }
  $('guessForm').onsubmit = (e) => {
    e.preventDefault();
    const v = $('guessInput').value.trim();
    if (!v) return;
    act('guess', v.slice(0, 100));
    $('guessInput').value = '';
  };

  // ---------- drawing ----------
  const canvas = $('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const W = canvas.width;
  const H = canvas.height;
  const MAIN_TARGET = [ctx, W, H];
  const COLORS = ['#000000', '#7f7f7f', '#ffffff', '#ef4565', '#ff8a3d', '#ffd23f', '#1fb86a', '#1e90ff', '#5b3df5', '#ff5fa8',
                  '#5c3a21', '#c3c3c3', '#ffd7b5', '#9c1d34', '#c75a00', '#a6862b', '#0e6b3c', '#0b4f8a', '#30207e', '#a8327a'];
  const SIZES = [0.005, 0.012, 0.025, 0.05];
  const isColor = (c) => typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c);
  let color = '#000000';
  let size = SIZES[1];
  let tool = 'pen';
  let strokeSeq = Math.floor(Math.random() * 1e6) * 1000;

  function clearCanvas() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
  }
  clearCanvas();

  // Ops: {t:'p', id, c, s, pts:[x,y,x,y...]} polyline, {t:'fill', id, x, y, c}, {t:'undo'}, {t:'clear'}
  function drawPoly(op) {
    if (!isColor(op.c) || !Array.isArray(op.pts) || op.pts.length < 2) return;
    const s = Math.min(0.2, Math.max(0.001, +op.s || 0.01));
    ctx.strokeStyle = op.c;
    ctx.lineWidth = s * W;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(op.pts[0] * W, op.pts[1] * H);
    if (op.pts.length === 2) ctx.lineTo(op.pts[0] * W + 0.01, op.pts[1] * H);
    for (let i = 2; i < op.pts.length; i += 2) ctx.lineTo(op.pts[i] * W, op.pts[i + 1] * H);
    ctx.stroke();
  }

  // target = [context, width, height]; defaults to the main board
  function floodFill(op, target) {
    const [ctx, W, H] = target || MAIN_TARGET;
    if (!isColor(op.c) || !(op.x >= 0 && op.x <= 1 && op.y >= 0 && op.y <= 1)) return;
    const x = Math.min(W - 1, Math.floor(op.x * W));
    const y = Math.min(H - 1, Math.floor(op.y * H));
    const img = ctx.getImageData(0, 0, W, H);
    const d = img.data;
    const i0 = (y * W + x) * 4;
    const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2];
    const fr = parseInt(op.c.slice(1, 3), 16), fg = parseInt(op.c.slice(3, 5), 16), fb = parseInt(op.c.slice(5, 7), 16);
    if (Math.abs(tr - fr) + Math.abs(tg - fg) + Math.abs(tb - fb) < 10) return;
    const tol = 90;
    const match = (i) => Math.abs(d[i] - tr) + Math.abs(d[i + 1] - tg) + Math.abs(d[i + 2] - tb) <= tol;
    const seen = new Uint8Array(W * H);
    const stack = [x, y];
    while (stack.length) {
      const py = stack.pop();
      let px = stack.pop();
      let idx = py * W + px;
      while (px >= 0 && !seen[idx] && match(idx * 4)) { px--; idx--; }
      px++; idx++;
      let up = false, down = false;
      while (px < W && !seen[idx] && match(idx * 4)) {
        seen[idx] = 1;
        const j = idx * 4;
        d[j] = fr; d[j + 1] = fg; d[j + 2] = fb; d[j + 3] = 255;
        if (py > 0) {
          const u = idx - W;
          if (!seen[u] && match(u * 4)) { if (!up) { stack.push(px, py - 1); up = true; } } else up = false;
        }
        if (py < H - 1) {
          const dn = idx + W;
          if (!seen[dn] && match(dn * 4)) { if (!down) { stack.push(px, py + 1); down = true; } } else down = false;
        }
        px++; idx++;
      }
    }
    ctx.putImageData(img, 0, 0);
  }

  function paint(op) {
    if (op.t === 'p') drawPoly(op);
    else if (op.t === 'fill') floodFill(op);
  }
  function redraw() {
    clearCanvas();
    localOps.forEach(paint);
  }
  function applyRemote(op) {
    if (op.t === 'undo') {
      const last = localOps.length ? localOps[localOps.length - 1].id : null;
      if (last !== null) localOps = localOps.filter((o) => o.id !== last);
      redraw();
    } else if (op.t === 'clear') {
      localOps = [];
      redraw();
    } else if (op.t === 'p' || op.t === 'fill') {
      localOps.push(op);
      paint(op);
    }
  }

  // Outgoing ops are batched so we stay well under Supabase's message limits.
  let outbox = [];
  let poly = null; // the stroke currently being drawn
  function flush() {
    if (poly && poly.pts.length >= 2) {
      const op = { t: 'p', id: poly.id, c: poly.c, s: poly.s, pts: poly.pts };
      outbox.push(op);
      localOps.push(op);
      // keep the last point so the next chunk connects
      poly.pts = poly.pts.slice(-2);
      poly.fresh = false;
    }
    if (outbox.length) {
      send('draw', { ops: outbox });
      outbox = [];
    }
  }
  setInterval(() => { if (poly && (poly.fresh || poly.pts.length > 2)) flush(); }, 120);

  function localAction(op) {
    flush();
    applyRemote(op);
    outbox.push(op);
    flush();
  }

  $('colors').append(
    ...COLORS.map((c) => {
      const b = el('button', 'swatch');
      b.style.background = c;
      b.title = c;
      b.dataset.c = c;
      b.onclick = () => {
        color = c;
        if (tool === 'eraser') tool = 'pen';
        refreshTools();
      };
      return b;
    })
  );
  $('sizes').append(
    ...SIZES.map((s, i) => {
      const b = el('button', 'size');
      const dot = el('i');
      dot.style.width = dot.style.height = `${6 + i * 6}px`;
      b.append(dot);
      b.dataset.s = s;
      b.onclick = () => { size = s; refreshTools(); };
      return b;
    })
  );
  document.querySelectorAll('[data-tool]').forEach((b) => (b.onclick = () => { tool = b.dataset.tool; refreshTools(); }));
  function refreshTools() {
    document.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === color && tool !== 'eraser'));
    document.querySelectorAll('.size').forEach((b) => b.classList.toggle('on', +b.dataset.s === size));
    document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  }
  refreshTools();
  $('undoBtn').onclick = () => isDrawer() && localAction({ t: 'undo' });
  $('clearBtn').onclick = () => isDrawer() && localAction({ t: 'clear' });
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && isDrawer()) {
      e.preventDefault();
      localAction({ t: 'undo' });
    }
  });

  const pos = (e) => {
    const r = canvas.getBoundingClientRect();
    const c = (v) => +Math.min(1, Math.max(0, v)).toFixed(4);
    return { x: c((e.clientX - r.left) / r.width), y: c((e.clientY - r.top) / r.height) };
  };
  let last = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (!isDrawer()) return;
    e.preventDefault();
    flush();
    const p = pos(e);
    const id = (strokeSeq = (strokeSeq + 1) % 2e9);
    if (tool === 'fill') {
      const op = { t: 'fill', id, x: p.x, y: p.y, c: color };
      localOps.push(op);
      paint(op);
      outbox.push(op);
      flush();
      return;
    }
    canvas.setPointerCapture(e.pointerId);
    poly = {
      id,
      c: tool === 'eraser' ? '#ffffff' : color,
      s: tool === 'eraser' ? Math.max(size, 0.025) : size,
      pts: [p.x, p.y],
      fresh: true,
    };
    last = p;
    drawPoly({ c: poly.c, s: poly.s, pts: [p.x, p.y] });
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!poly || !isDrawer()) return;
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = pos(ev);
      if (Math.hypot(p.x - last.x, p.y - last.y) < 0.002) continue;
      drawPoly({ c: poly.c, s: poly.s, pts: [last.x, last.y, p.x, p.y] });
      poly.pts.push(p.x, p.y);
      last = p;
    }
  });
  const stop = () => {
    if (!poly) return;
    if (poly.fresh || poly.pts.length > 2) flush();
    poly = null;
    last = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);

  // ---------- live cursors ----------
  // Only the drawer's mouse is shared: guessers see it move over the board with the drawer's avatar.
  // Updates are throttled (~7 per second) and smoothed with CSS, to stay inside Supabase's free limits.
  const cursors = new Map(); // playerId -> { el, timer }
  const wrap = $('canvasWrap');

  const cursorFace = (p) => avatarNode(p, 'cur-av');

  function hideOtherCursors() {
    const live = state && state.phase === 'drawing' ? state.drawerId : null;
    cursors.forEach((c, id) => { if (id !== live) c.el.classList.remove('show'); });
  }

  function moveCursor(id, x, y) {
    if (!state) return;
    let c = cursors.get(id);
    if (typeof x !== 'number' || typeof y !== 'number' || x < 0 || x > 1 || y < 0 || y > 1) {
      if (c) c.el.classList.remove('show');
      return;
    }
    const p = state.players.find((q) => q.id === id);
    if (!p) return;
    if (!c) {
      const e = el('div', 'cursor');
      c = { el: e, timer: null, key: '' };
      cursors.set(id, c);
      wrap.append(e);
    }
    const key = `${p.name}|${p.avatar}|${picUrl(p) ? p.uid + p.pv : ''}`;
    if (c.key !== key) {
      c.key = key;
      c.el.replaceChildren(el('span', 'cur-arrow'), cursorFace(p), el('span', 'cur-name', p.name));
    }
    c.el.style.transform = `translate(${x * wrap.clientWidth}px, ${y * wrap.clientHeight}px)`;
    c.el.classList.add('show');
    clearTimeout(c.timer);
    c.timer = setTimeout(() => c.el.classList.remove('show'), 4000);
  }

  let curPending = null;
  let curSent = null;
  wrap.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse' || !channel || !isDrawer()) return;
    const r = wrap.getBoundingClientRect();
    curPending = { x: +((e.clientX - r.left) / r.width).toFixed(3), y: +((e.clientY - r.top) / r.height).toFixed(3) };
  });
  wrap.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse' && isDrawer()) curPending = { x: -1, y: -1 };
  });
  setInterval(() => {
    if (!curPending || (curSent && curPending.x === curSent.x && curPending.y === curSent.y)) return;
    send('cur', curPending);
    curSent = curPending;
  }, 150);

  // ---------- accounts ----------
  const authModal = $('authModal');
  const avatarModal = $('avatarModal');
  let authMode = 'login';

  function openModal(m) { m.hidden = false; }
  function closeModal(m) { m.hidden = true; }
  document.querySelectorAll('.modal').forEach((m) => {
    m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(m); });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.modal').forEach(closeModal);
  });

  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('#authForm .tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === mode));
    document.querySelector('#authForm .signup-only').hidden = mode !== 'signup';
    $('authSubmit').textContent = mode === 'signup' ? '✨ Make my account' : 'Log in';
    $('authPass').autocomplete = mode === 'signup' ? 'new-password' : 'current-password';
    $('authMsg').textContent = '';
    $('authMsg').classList.remove('ok');
  }
  document.querySelectorAll('#authForm .tab').forEach((t) => (t.onclick = () => setAuthMode(t.dataset.mode)));
  $('openAuth').onclick = () => {
    setAuthMode('login');
    openModal(authModal);
    $('authEmail').focus();
  };

  function authMessage(text, ok = false) {
    $('authMsg').textContent = text;
    $('authMsg').classList.toggle('ok', ok);
  }

  $('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const email = $('authEmail').value.trim();
    const password = $('authPass').value;
    const btn = $('authSubmit');
    btn.disabled = true;
    try {
      if (authMode === 'signup') {
        const name = $('authName').value.trim().slice(0, 16) || email.split('@')[0].slice(0, 16);
        const { data, error } = await sb.auth.signUp({
          email,
          password,
          options: { data: { display_name: name }, emailRedirectTo: location.origin + location.pathname },
        });
        if (error) return authMessage(error.message);
        if (!data.session) return authMessage('Almost done! Check your email to confirm your account, then log in.', true);
        await ensureProfile(data.user, name);
      } else {
        const { data, error } = await sb.auth.signInWithPassword({ email, password });
        if (error) return authMessage(error.message === 'Invalid login credentials' ? 'Wrong email or password.' : error.message);
        await ensureProfile(data.user);
      }
      closeModal(authModal);
      $('authPass').value = '';
      toast('Signed in! Tap 🎨 Avatar to draw yours.');
    } finally {
      btn.disabled = false;
    }
  };

  async function ensureProfile(user, name) {
    if (!user) return;
    const { data } = await sb.from('player_profiles').select('id, display_name, avatar, updated_at').eq('id', user.id).maybeSingle();
    if (data) return setAccount(user, data);
    const display = (name || user.user_metadata?.display_name || user.email?.split('@')[0] || 'Player').slice(0, 16);
    const { data: created, error } = await sb.from('player_profiles').insert({ id: user.id, display_name: display }).select().single();
    setAccount(user, error ? null : created);
  }

  function setAccount(user, profile) {
    account = { user, profile, pv: profile ? Date.parse(profile.updated_at) || 0 : 0 };
    if (user && profile) pics.set(user.id, { pv: account.pv, url: profile.avatar || null });
    renderAccount();
    if (user && profile && !nameInput.value.trim()) nameInput.value = profile.display_name;
    if (channel && state) send('hello', helloPayload()); // update my avatar in the current game
  }

  function renderAccount() {
    const signedIn = !!account.user;
    $('acctOut').hidden = signedIn;
    $('acctIn').hidden = !signedIn;
    if (!signedIn) return;
    $('acctName').textContent = account.profile?.display_name || account.user.email;
    const pic = $('acctPic');
    pic.replaceChildren();
    if (account.profile?.avatar) {
      const img = el('img');
      img.src = account.profile.avatar;
      img.alt = 'Your avatar';
      pic.append(img);
    } else {
      pic.textContent = '🙂';
    }
  }

  $('signOut').onclick = async () => {
    await sb.auth.signOut();
    setAccount(null, null);
    toast('Signed out');
  };

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') return setAccount(null, null);
    if (session?.user && session.user.id !== account.user?.id) ensureProfile(session.user);
  });
  sb.auth.getSession().then(({ data }) => { if (data.session?.user) ensureProfile(data.session.user); });

  // ---------- avatar editor (small 96×96 drawing, shown tiny in game) ----------
  const av = $('avCanvas');
  const avCtx = av.getContext('2d', { willReadFrequently: true });
  const AV = av.width;
  const AV_SIZES = [2, 5, 10];
  let avColor = '#000000';
  let avSize = AV_SIZES[1];
  let avTool = 'pen';
  let avHistory = [];
  let avLast = null;

  function avReset(src) {
    avCtx.fillStyle = '#ffffff';
    avCtx.fillRect(0, 0, AV, AV);
    avHistory = [];
    if (src) {
      const img = new Image();
      img.onload = () => avCtx.drawImage(img, 0, 0, AV, AV);
      img.src = src;
    }
  }

  avReset();
  $('editAvatar').onclick = () => {
    avReset(account.profile?.avatar);
    $('avMsg').textContent = '';
    openModal(avatarModal);
  };

  $('avColors').append(
    ...COLORS.map((c) => {
      const b = el('button', 'swatch');
      b.style.background = c;
      b.dataset.c = c;
      b.onclick = () => { avColor = c; if (avTool === 'eraser') avTool = 'pen'; avRefresh(); };
      return b;
    })
  );
  $('avSizes').append(
    ...AV_SIZES.map((s, i) => {
      const b = el('button', 'size');
      const dot = el('i');
      dot.style.width = dot.style.height = `${6 + i * 6}px`;
      b.append(dot);
      b.dataset.s = s;
      b.onclick = () => { avSize = s; avRefresh(); };
      return b;
    })
  );
  document.querySelectorAll('[data-avtool]').forEach((b) => (b.onclick = () => { avTool = b.dataset.avtool; avRefresh(); }));
  function avRefresh() {
    $('avColors').querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b.dataset.c === avColor && avTool !== 'eraser'));
    $('avSizes').querySelectorAll('.size').forEach((b) => b.classList.toggle('on', +b.dataset.s === avSize));
    document.querySelectorAll('[data-avtool]').forEach((b) => b.classList.toggle('on', b.dataset.avtool === avTool));
  }
  avRefresh();

  const avSnap = () => {
    avHistory.push(avCtx.getImageData(0, 0, AV, AV));
    if (avHistory.length > 30) avHistory.shift();
  };
  $('avUndo').onclick = () => { if (avHistory.length) avCtx.putImageData(avHistory.pop(), 0, 0); };
  $('avClear').onclick = () => { avSnap(); avCtx.fillStyle = '#fff'; avCtx.fillRect(0, 0, AV, AV); };

  const avPos = (e) => {
    const r = av.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * AV, y: ((e.clientY - r.top) / r.height) * AV };
  };
  function avLine(a, b) {
    avCtx.strokeStyle = avTool === 'eraser' ? '#ffffff' : avColor;
    avCtx.lineWidth = avTool === 'eraser' ? Math.max(avSize, 6) : avSize;
    avCtx.lineCap = 'round';
    avCtx.lineJoin = 'round';
    avCtx.beginPath();
    avCtx.moveTo(a.x, a.y);
    avCtx.lineTo(b.x + (a.x === b.x && a.y === b.y ? 0.01 : 0), b.y);
    avCtx.stroke();
  }
  av.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    avSnap();
    const p = avPos(e);
    if (avTool === 'fill') {
      floodFill({ x: p.x / AV, y: p.y / AV, c: avColor }, [avCtx, AV, AV]);
      return;
    }
    av.setPointerCapture(e.pointerId);
    avLast = p;
    avLine(p, p);
  });
  av.addEventListener('pointermove', (e) => {
    if (!avLast) return;
    const p = avPos(e);
    avLine(avLast, p);
    avLast = p;
  });
  const avStop = () => { avLast = null; };
  av.addEventListener('pointerup', avStop);
  av.addEventListener('pointercancel', avStop);

  $('avSave').onclick = async () => {
    if (!account.user) return;
    const btn = $('avSave');
    btn.disabled = true;
    $('avMsg').textContent = '';
    try {
      let url = av.toDataURL('image/png');
      if (url.length > 30000) {
        // Very detailed drawing: shrink it so it stays small.
        const small = document.createElement('canvas');
        small.width = small.height = 64;
        small.getContext('2d').drawImage(av, 0, 0, 64, 64);
        url = small.toDataURL('image/png');
      }
      const display = account.profile?.display_name || nameInput.value.trim() || 'Player';
      const { data, error } = await sb
        .from('player_profiles')
        .upsert({ id: account.user.id, display_name: display.slice(0, 16), avatar: url })
        .select()
        .single();
      if (error) {
        $('avMsg').textContent = "Couldn't save, try again.";
        return;
      }
      setAccount(account.user, data);
      closeModal(avatarModal);
      toast('Avatar saved! 🎨');
    } finally {
      btn.disabled = false;
    }
  };

  // ---------- extras: toast, sounds, confetti ----------
  let toastTimer;
  function toast(text) {
    const t = $('toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  let audio;
  function beep(freq, dur = 0.12, type = 'sine', vol = 0.15, delay = 0) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator();
      const g = audio.createGain();
      const t0 = audio.currentTime + delay;
      o.type = type;
      o.frequency.value = freq;
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g).connect(audio.destination);
      o.start(t0);
      o.stop(t0 + dur);
    } catch {}
  }
  const sfx = {
    ding: () => beep(880, 0.15, 'triangle', 0.08),
    win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.18, 'triangle', 0.15, i * 0.08)),
    tick: () => beep(1200, 0.04, 'square', 0.04),
    turn: () => [660, 880].forEach((f, i) => beep(f, 0.15, 'sine', 0.12, i * 0.1)),
    fanfare: () => [523, 523, 784, 659, 1047].forEach((f, i) => beep(f, 0.25, 'triangle', 0.15, i * 0.13)),
  };

  function confetti(n) {
    const colors = ['#ffcc33', '#ff5fa8', '#5b3df5', '#1fb86a', '#1e90ff', '#ff8a3d'];
    for (let i = 0; i < n; i++) {
      const c = el('div', 'confetti');
      c.style.left = `${Math.random() * 100}vw`;
      c.style.background = colors[i % colors.length];
      c.style.animationDuration = `${1.8 + Math.random() * 1.8}s`;
      c.style.animationDelay = `${Math.random() * 0.5}s`;
      document.body.append(c);
      setTimeout(() => c.remove(), 4500);
    }
  }
})();
