const base = process.env.BASE_URL || "http://127.0.0.1:8787";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

async function login(name) {
  const response = await fetch(`${base}/auth/dev`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await response.json();
  assert(response.ok, `dev login failed ${response.status} ${JSON.stringify(body)}`);
  const cookie = response.headers.getSetCookie().find((row) => row.startsWith("tg_session="));
  assert(cookie, "missing session cookie");
  const token = cookie.split(";")[0].slice("tg_session=".length);
  return { user: body.user, token };
}

function track(ws) {
  const queue = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
    const index = waiters.findIndex((waiter) => waiter.pred(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      queue.push(msg);
    }
  });
  return {
    next(pred, ms = 10000) {
      const index = queue.findIndex(pred);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting, queued ${queue.map((row) => row.t).join(",")}`)), ms);
        waiters.push({ pred, resolve, reject, timer });
      });
    },
    has(pred) {
      return queue.some(pred);
    },
  };
}

function openSocket(url) {
  const ws = new WebSocket(url);
  const tracker = track(ws);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`open timeout ${url}`)), 8000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve({ ws, tracker });
    });
    ws.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new Error(`socket error ${url}`));
    });
  });
}

async function finish(sock, tracker, sentence) {
  // One verified character at a time, paced under the server rate limit.
  let text = "";
  for (let i = 1; i <= sentence.length; i++) {
    text = sentence.slice(0, i);
    sock.send(JSON.stringify({ t: i === sentence.length ? "fin" : "prog", text }));
    await new Promise((resolve) => setTimeout(resolve, 45));
  }
  return tracker.next((msg) => msg.t === "state" && msg.players.some((player) => player.i === sentence.length && player.finishedAt), 20000);
}

const health = await fetch(`${base}/api/health`);
assert(health.ok, "health failed, apply D1 migrations");
const config = await (await fetch(`${base}/api/config`)).json();
assert(config.devLogin === true, "dev login should be on locally");
assert(config.lengths?.map((row) => row.id).join(",") === "sprint,set,long", "length list");
const page = await fetch(`${base}/`);
assert(page.ok, "home page failed");
assert((await page.text()).includes("Typing race"), "home page title missing");
const bad = await fetch(`${base}/api/leaderboard?mode=nope`);
assert(bad.status === 400, "bad mode should be 400");

const wsBase = base.replace(/^http/, "ws");
const ada = await login("Ada");
const bea = await login("Bea");
const adaLobby = await openSocket(`${wsBase}/ws?t=${encodeURIComponent(ada.token)}`);
const beaLobby = await openSocket(`${wsBase}/ws?t=${encodeURIComponent(bea.token)}`);
const adaWs = adaLobby.ws;
const beaSocket = beaLobby.ws;
const adaTrack = adaLobby.tracker;
const beaTrack = beaLobby.tracker;
adaWs.send(JSON.stringify({ t: "queue", mode: "desktop", length: "long" }));
beaSocket.send(JSON.stringify({ t: "queue", mode: "desktop", length: "sprint" }));
await new Promise((resolve) => setTimeout(resolve, 2200));
assert(!adaTrack.has((msg) => msg.t === "match"), "a long queue matched a sprint");
assert(!beaTrack.has((msg) => msg.t === "match"), "a sprint queue matched a long");
adaWs.send(JSON.stringify({ t: "leave" }));
beaSocket.send(JSON.stringify({ t: "leave" }));
await new Promise((resolve) => setTimeout(resolve, 100));
beaSocket.send(JSON.stringify({ t: "queue", mode: "desktop", length: "sprint" }));
adaWs.send(JSON.stringify({ t: "queue", mode: "desktop", length: "sprint" }));

const adaMatch = await adaTrack.next((msg) => msg.t === "match");
const beaMatch = await beaTrack.next((msg) => msg.t === "match");
assert(adaMatch.raceId === beaMatch.raceId, "racers got different rooms");
assert(adaMatch.sentence === beaMatch.sentence, "racers got different sentences");
assert(adaMatch.ranked === true, "queue should be rated");
assert(adaMatch.length === "sprint", "queue length");
assert(adaMatch.sentence.length > 0, "empty sentence");

const wait = Math.max(0, adaMatch.startAt - Date.now() + 120);
await new Promise((resolve) => setTimeout(resolve, wait));

const adaRaceConn = await openSocket(`${wsBase}/ws?race=${adaMatch.raceId}&t=${encodeURIComponent(ada.token)}`);
const beaRaceConn = await openSocket(`${wsBase}/ws?race=${beaMatch.raceId}&t=${encodeURIComponent(bea.token)}`);
const adaRaceWs = adaRaceConn.ws;
const beaRaceWs = beaRaceConn.ws;
const adaRace = adaRaceConn.tracker;
const beaRace = beaRaceConn.tracker;
await adaRace.next((msg) => msg.t === "hello");
await beaRace.next((msg) => msg.t === "hello");

await finish(beaRaceWs, beaRace, beaMatch.sentence);
await new Promise((resolve) => setTimeout(resolve, 200));
await finish(adaRaceWs, adaRace, adaMatch.sentence);
const results = await adaRace.next((msg) => msg.t === "results", 8000);
assert(results.rows[0].id === bea.user.id, `expected Bea first, got ${results.rows[0].name}`);
assert(results.rows[0].place === 1, "winner place");
assert(results.rows[1].id === ada.user.id, "Ada should be second");
assert(results.rows[0].eloAfter === 1016, `winner elo ${results.rows[0].eloAfter}`);
assert(results.rows[1].eloAfter === 984, `second elo ${results.rows[1].eloAfter}`);
assert(results.rows[0].ms < results.rows[1].ms, "finish times out of order");

const board = await (await fetch(`${base}/api/leaderboard?mode=desktop`)).json();
const beaRow = board.rows.find((row) => row.id === bea.user.id);
assert(beaRow?.elo.desktop === 1016, "ladder elo was not saved");

const adaProfile = await (await fetch(`${base}/api/me`, { headers: { cookie: `tg_session=${ada.token}` } })).json();
assert(adaProfile.user.elo.desktop === 984, "profile elo was not saved");
const beaProfile = await (await fetch(`${base}/api/me`, { headers: { cookie: `tg_session=${bea.token}` } })).json();
assert(beaProfile.user.wins.desktop === 1, "win was not counted");

adaWs.send(JSON.stringify({ t: "rematch", raceId: adaMatch.raceId }));
const adaOffer = await adaTrack.next((msg) => msg.t === "rematch");
const beaOffer = await beaTrack.next((msg) => msg.t === "rematch");
assert(adaOffer.ready.includes(ada.user.id), "ada was not ready");
assert(beaOffer.ready.includes(ada.user.id), "bea did not see the rematch");
assert(adaOffer.started !== true, "one click started the rematch");
adaWs.send(JSON.stringify({ t: "rematch_cancel" }));
const adaClear = await adaTrack.next((msg) => msg.t === "rematch");
const beaClear = await beaTrack.next((msg) => msg.t === "rematch");
assert(!adaClear.ready.includes(ada.user.id), "cancel kept ada ready");
assert(!beaClear.ready.includes(ada.user.id), "bea still saw ada ready");
await new Promise((resolve) => setTimeout(resolve, 300));
assert(!adaTrack.has((msg) => msg.t === "match"), "cancel started a race");
assert(!beaTrack.has((msg) => msg.t === "match"), "cancel started bea's race");
adaWs.send(JSON.stringify({ t: "rematch", raceId: adaMatch.raceId }));
beaSocket.send(JSON.stringify({ t: "rematch", raceId: beaMatch.raceId }));
const adaAgain = await adaTrack.next((msg) => msg.t === "match");
const beaAgain = await beaTrack.next((msg) => msg.t === "match");
assert(adaAgain.raceId === beaAgain.raceId, "rematch split the room");
assert(adaAgain.raceId !== adaMatch.raceId, "rematch reused the race");
assert(adaAgain.ranked === true, "rematch should stay rated");
assert(adaAgain.mode === "desktop" && adaAgain.length === "sprint", "rematch changed the format");
assert(adaAgain.sentence.length > 0, "rematch passage was empty");
const adaAgainConn = await openSocket(`${wsBase}/ws?race=${adaAgain.raceId}&t=${encodeURIComponent(ada.token)}`);
const beaAgainConn = await openSocket(`${wsBase}/ws?race=${beaAgain.raceId}&t=${encodeURIComponent(bea.token)}`);
await adaAgainConn.tracker.next((msg) => msg.t === "hello");
await beaAgainConn.tracker.next((msg) => msg.t === "hello");
adaAgainConn.ws.close();
beaAgainConn.ws.close();

adaWs.send(JSON.stringify({ t: "practice", mode: "cursor", length: "set" }));
const practice = await adaTrack.next((msg) => msg.t === "match" && msg.ranked === false);
assert(practice.mode === "cursor", "practice mode");
assert(practice.length === "set", "practice length");
assert(practice.sentence.length >= 48, "a set should be three sentences");
const practiceConn = await openSocket(`${wsBase}/ws?race=${practice.raceId}&t=${encodeURIComponent(ada.token)}`);
const practiceWs = practiceConn.ws;
const practiceTrack = practiceConn.tracker;
await practiceTrack.next((msg) => msg.t === "hello");
await new Promise((resolve) => setTimeout(resolve, Math.max(0, practice.startAt - Date.now() + 80)));
await finish(practiceWs, practiceTrack, practice.sentence);
const practiceResults = await practiceTrack.next((msg) => msg.t === "results");
assert(practiceResults.ranked === false, "practice should be unrated");
assert(practiceResults.rows[0].eloAfter == null, "practice changed elo");
const after = await (await fetch(`${base}/api/me`, { headers: { cookie: `tg_session=${ada.token}` } })).json();
assert(after.user.elo.desktop === 984, "practice wrote desktop elo");
assert(after.user.best.cursor > 0, "practice should record a cursor best");

adaWs.send(JSON.stringify({ t: "room_create", mode: "desktop", length: "set" }));
const adaRoom = await adaTrack.next((msg) => msg.t === "room" && msg.youHost === true);
assert(adaRoom.players.length === 1, "host missing from the new room");
const cam = await login("Cam");
const camLobby = await openSocket(`${wsBase}/ws?t=${encodeURIComponent(cam.token)}`);
camLobby.ws.send(JSON.stringify({ t: "browse" }));
const listed = await camLobby.tracker.next((msg) => msg.t === "rooms" && msg.rooms.some((room) => room.code === adaRoom.code));
const listedRoom = listed.rooms.find((room) => room.code === adaRoom.code);
assert(listed.max === 6, "room max");
assert(listedRoom.mode === "desktop" && listedRoom.length === "set", "listed format");
assert(listedRoom.players.length === 1 && listedRoom.players[0].name === "Ada" && listedRoom.players[0].host === true, "listed host");
beaSocket.send(JSON.stringify({ t: "room_join", code: adaRoom.code }));
const joined = await camLobby.tracker.next((msg) => msg.t === "rooms" && msg.rooms.some((room) => room.code === adaRoom.code && room.players.length === 2));
const joinedRoom = joined.rooms.find((room) => room.code === adaRoom.code);
assert(joinedRoom.players.map((player) => player.name).sort().join(",") === "Ada,Bea", "join did not update the list");
beaSocket.send(JSON.stringify({ t: "leave" }));
await camLobby.tracker.next((msg) => msg.t === "rooms" && msg.rooms.some((room) => room.code === adaRoom.code && room.players.length === 1));
adaWs.send(JSON.stringify({ t: "leave" }));
const cleared = await camLobby.tracker.next((msg) => msg.t === "rooms" && !msg.rooms.some((room) => room.code === adaRoom.code));
assert(cleared.t === "rooms", "room left the list");
camLobby.ws.close();

adaWs.close();
beaSocket.close();
adaRaceWs.close();
beaRaceWs.close();
practiceWs.close();
console.log("live race ok");
