/* FauxCode profile: Game development — ember-engine */
(function () {
'use strict';
const SRC = {};

/* ================= existing corpus (ported verbatim from workbench.html) ================= */

SRC.GD_PARTICLE = `import { Vec2 } from '../math/vec2';
import { Renderer } from '../render/renderer';

// ENG-451: particle system rewrite.
// Previous version allocated 40k objects per frame. It is in a better place now.

const MAX_PARTICLES = 4096;

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  life: number; maxLife: number;
  size: number; hue: number;
}

export class ParticleSystem {
  private readonly pool: Particle[] = [];
  private alive = 0;

  constructor(private readonly gravity: Vec2) {
    // preallocate everything. the garbage collector is not invited to this party.
    for (let i = 0; i < MAX_PARTICLES; i++) {
      this.pool.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, maxLife: 0, size: 1, hue: 0 });
    }
  }

  emit(origin: Vec2, count: number, speed: number, hue: number): void {
    for (let i = 0; i < count && this.alive < MAX_PARTICLES; i++) {
      const p = this.pool[this.alive++];
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.5 + Math.random() * 0.5);
      p.x = origin.x;
      p.y = origin.y;
      p.vx = Math.cos(angle) * velocity;
      p.vy = Math.sin(angle) * velocity;
      p.maxLife = 0.6 + Math.random() * 1.2;
      p.life = p.maxLife;
      p.size = 1 + Math.random() * 3;
      p.hue = hue + randistort(12);
    }
  }

  update(dt: number): void {
    let i = 0;
    while (i < this.alive) {
      const p = this.pool[i];
      p.life -= dt;
      if (p.life <= 0) {
        // swap-remove: order does not matter, speed does
        this.alive--;
        this.pool[i] = this.pool[this.alive];
        this.pool[this.alive] = p;
        continue;
      }
      p.vx += this.gravity.x * dt;
      p.vy += this.gravity.y * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      i++;
    }
  }

  render(renderer: Renderer): void {
    for (let i = 0; i < this.alive; i++) {
      const p = this.pool[i];
      const fade = p.life / p.maxLife;
      renderer.drawPoint(p.x, p.y, p.size * fade, p.hue, fade);
    }
  }
}

function randistort(range: number): number {
  return (Math.random() - 0.5) * 2 * range;
}
`;

SRC.GD_PHYSICS = `import { Vec2 } from '../math/vec2';

// Fixed-timestep physics. Gravity tuned by feel.
// Do not consult real physicists; they have opinions.

const FIXED_DT = 1 / 120;
const MAX_STEPS = 8;

export interface Body {
  pos: Vec2;
  vel: Vec2;
  halfW: number;
  halfH: number;
  grounded: boolean;
  isStatic: boolean;
}

export class PhysicsWorld {
  private readonly bodies: Body[] = [];
  private accumulator = 0;

  constructor(private readonly gravity = new Vec2(0, 980)) {}

  add(body: Body): void {
    this.bodies.push(body);
  }

  tick(frameDt: number): void {
    this.accumulator += Math.min(frameDt, 0.25); // spiral-of-death insurance
    let steps = 0;
    while (this.accumulator >= FIXED_DT && steps < MAX_STEPS) {
      this.step(FIXED_DT);
      this.accumulator -= FIXED_DT;
      steps++;
    }
  }

  private step(dt: number): void {
    for (const body of this.bodies) {
      if (body.isStatic) continue;
      body.vel.y += this.gravity.y * dt;
      body.pos.x += body.vel.x * dt;
      body.pos.y += body.vel.y * dt;
      body.grounded = false;
    }
    this.resolveCollisions();
  }

  private resolveCollisions(): void {
    for (let a = 0; a < this.bodies.length; a++) {
      for (let b = a + 1; b < this.bodies.length; b++) {
        const first = this.bodies[a];
        const second = this.bodies[b];
        if (first.isStatic && second.isStatic) continue;

        const dx = second.pos.x - first.pos.x;
        const dy = second.pos.y - first.pos.y;
        const overlapX = first.halfW + second.halfW - Math.abs(dx);
        const overlapY = first.halfH + second.halfH - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;

        // resolve along the shallow axis; the deep axis is lying to you
        if (overlapX < overlapY) {
          this.separate(first, second, Math.sign(dx) * overlapX, 0);
        } else {
          this.separate(first, second, 0, Math.sign(dy) * overlapY);
          if (dy > 0) first.grounded = true;
          else second.grounded = true;
        }
      }
    }
  }

  private separate(a: Body, b: Body, dx: number, dy: number): void {
    const mover = a.isStatic ? b : a;
    const sign = a.isStatic ? 1 : -1;
    mover.pos.x += dx * sign;
    mover.pos.y += dy * sign;
    if (dx !== 0) mover.vel.x = 0;
    if (dy !== 0) mover.vel.y = 0;
  }
}
`;

SRC.GD_SHADER = `// fire.frag — particle fire shader.
// Cranked the glow until the art director smiled. Do not lower it.

precision mediump float;

uniform sampler2D u_noise;
uniform float u_time;
uniform vec2 u_resolution;

varying vec2 v_uv;

float noiseLayer(vec2 uv, float speed, float scale) {
  vec2 offset = vec2(0.0, u_time * speed);
  return texture2D(u_noise, uv * scale + offset).r;
}

void main() {
  vec2 uv = v_uv;

  // stack three noise octaves; fire is just spicy clouds
  float n = 0.0;
  n += noiseLayer(uv, 0.35, 1.0) * 0.5;
  n += noiseLayer(uv, 0.55, 2.3) * 0.3;
  n += noiseLayer(uv, 0.90, 4.7) * 0.2;

  // shape: hotter at the bottom, wispy at the top
  float shape = pow(1.0 - uv.y, 1.6);
  float intensity = clamp(n * shape * 2.2, 0.0, 1.0);

  vec3 cold = vec3(0.05, 0.02, 0.02);
  vec3 mid = vec3(0.9, 0.35, 0.05);
  vec3 hot = vec3(1.0, 0.9, 0.55);

  vec3 color = mix(cold, mid, smoothstep(0.15, 0.6, intensity));
  color = mix(color, hot, smoothstep(0.75, 0.95, intensity));

  gl_FragColor = vec4(color, intensity);
}
`;

SRC.GD_LEVEL = `import { PhysicsWorld } from '../physics/physics.world';
import { Vec2 } from '../math/vec2';

// Level loader. Levels are JSON because the level editor is a spreadsheet.

interface LevelData {
  name: string;
  gravity: number;
  tiles: number[][];
  spawns: { x: number; y: number; kind: string }[];
}

const TILE_SIZE = 32;

export class LevelLoader {
  async load(url: string, world: PhysicsWorld): Promise<LevelData> {
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error('level not found: ' + url);
    }
    const data = (await res.json()) as LevelData;
    this.buildColliders(data, world);
    return data;
  }

  private buildColliders(data: LevelData, world: PhysicsWorld): void {
    // greedy horizontal merge: 40 tiles become 3 colliders and the
    // physics thread sends a thank-you card
    for (let row = 0; row < data.tiles.length; row++) {
      let runStart = -1;
      for (let col = 0; col <= data.tiles[row].length; col++) {
        const solid = col < data.tiles[row].length && data.tiles[row][col] === 1;
        if (solid && runStart < 0) {
          runStart = col;
        }
        if (!solid && runStart >= 0) {
          const width = col - runStart;
          world.add({
            pos: new Vec2((runStart + width / 2) * TILE_SIZE, (row + 0.5) * TILE_SIZE),
            vel: new Vec2(0, 0),
            halfW: (width * TILE_SIZE) / 2,
            halfH: TILE_SIZE / 2,
            grounded: false,
            isStatic: true,
          });
          runStart = -1;
        }
      }
    }
  }
}
`;

SRC.GD_ENEMY = `import { Vec2 } from '../math/vec2';

// Enemy AI: a tiny state machine.
// "Smart enough to be fun, dumb enough to be beatable" — design doc, page 1.

type AiState = 'patrol' | 'chase' | 'attack' | 'flee';

const SIGHT_RANGE = 260;
const ATTACK_RANGE = 48;
const FLEE_HEALTH = 0.25;

export class EnemyBrain {
  private state: AiState = 'patrol';
  private patrolDir = 1;

  think(self: { pos: Vec2; health: number }, player: { pos: Vec2 }, dt: number): Vec2 {
    const toPlayer = player.pos.sub(self.pos);
    const distance = toPlayer.length();

    if (self.health < FLEE_HEALTH) {
      this.state = 'flee';
    } else if (distance < ATTACK_RANGE) {
      this.state = 'attack';
    } else if (distance < SIGHT_RANGE) {
      this.state = 'chase';
    } else {
      this.state = 'patrol';
    }

    switch (this.state) {
      case 'patrol':
        // walk until bored, then walk the other way
        if (Math.random() < 0.005) this.patrolDir *= -1;
        return new Vec2(this.patrolDir * 40, 0);
      case 'chase':
        return toPlayer.normalize().scale(90);
      case 'attack':
        return new Vec2(0, 0); // stop and swing
      case 'flee':
        return toPlayer.normalize().scale(-120); // courage is a resource
    }
  }
}
`;

SRC.GD_RENDERER = `export class Renderer {
  private readonly ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
  }

  clear(width: number, height: number): void {
    this.ctx.clearRect(0, 0, width, height);
  }

  drawPoint(x: number, y: number, size: number, hue: number, alpha: number): void {
    this.ctx.globalAlpha = alpha;
    this.ctx.fillStyle = 'hsl(' + hue + ', 90%, 60%)';
    this.ctx.fillRect(x - size / 2, y - size / 2, size, size);
    this.ctx.globalAlpha = 1;
  }
}
`;

SRC.GD_INPUT = `const PRESSED = new Set<string>();

export function initInput(): void {
  window.addEventListener('keydown', (e) => PRESSED.add(e.code));
  window.addEventListener('keyup', (e) => PRESSED.delete(e.code));
  window.addEventListener('blur', () => PRESSED.clear()); // alt-tab forgiveness
}

export function isDown(code: string): boolean {
  return PRESSED.has(code);
}

export function axis(negative: string, positive: string): number {
  return (isDown(positive) ? 1 : 0) - (isDown(negative) ? 1 : 0);
}
`;

SRC.GD_VEC2 = `export class Vec2 {
  constructor(public x: number, public y: number) {}

  add(o: Vec2): Vec2 { return new Vec2(this.x + o.x, this.y + o.y); }
  sub(o: Vec2): Vec2 { return new Vec2(this.x - o.x, this.y - o.y); }
  scale(s: number): Vec2 { return new Vec2(this.x * s, this.y * s); }

  length(): number {
    return Math.hypot(this.x, this.y);
  }

  normalize(): Vec2 {
    const len = this.length();
    return len > 0 ? new Vec2(this.x / len, this.y / len) : new Vec2(0, 0);
  }
}
`;

SRC.GD_MANIFEST = `{
  "atlas": "atlas_main.png",
  "tileSize": 32,
  "sprites": {
    "player_idle": { "frames": 4, "fps": 8 },
    "player_run": { "frames": 8, "fps": 14 },
    "slime": { "frames": 6, "fps": 10 },
    "torch": { "frames": 5, "fps": 12 },
    "coin": { "frames": 8, "fps": 16 }
  },
  "audio": {
    "jump": "sfx/jump.ogg",
    "coin": "sfx/coin.ogg",
    "music_forest": "music/forest_loop.ogg"
  }
}
`;

/* ================= new corpus ================= */

SRC.GD_LOBBY = `// ENG-433: playtest lobby client.
// Talks to lobby.internal.corp over WebSocket. Reconnects with exponential
// backoff, which is a polite way of saying it keeps knocking until someone answers.

type LobbyMessage =
  | { type: 'hello'; playerId: string; build: string }
  | { type: 'join'; room: string }
  | { type: 'leave' }
  | { type: 'ping'; sentAt: number }
  | { type: 'input'; frame: number; axisX: number; jump: boolean };

type ServerMessage =
  | { type: 'welcome'; playerId: string; tickRate: number }
  | { type: 'pong'; sentAt: number }
  | { type: 'roster'; players: string[] }
  | { type: 'error'; reason: string };

type Listener = (msg: ServerMessage) => void;

const HEARTBEAT_MS = 5000;
const MAX_BACKOFF_MS = 30000;
const BUILD_ID = 'ember-engine@0.9.4';

export class LobbyClient {
  private socket: WebSocket | null = null;
  private listeners: Listener[] = [];
  private outbox: LobbyMessage[] = [];
  private attempts = 0;
  private heartbeat: number | undefined;
  private closedByUs = false;
  rttMs = 0;

  constructor(private readonly url: string, private readonly playerId: string) {}

  connect(): void {
    this.closedByUs = false;
    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.onopen = () => {
      this.attempts = 0;
      this.send({ type: 'hello', playerId: this.playerId, build: BUILD_ID });
      this.flush();
      this.heartbeat = window.setInterval(() => {
        this.send({ type: 'ping', sentAt: performance.now() });
      }, HEARTBEAT_MS);
    };

    socket.onmessage = (event) => {
      const msg = this.parse(event.data);
      if (!msg) return;
      if (msg.type === 'pong') this.rttMs = performance.now() - msg.sentAt;
      for (const listener of this.listeners) listener(msg);
    };

    socket.onclose = () => {
      window.clearInterval(this.heartbeat);
      this.socket = null;
      if (!this.closedByUs) this.scheduleReconnect();
    };

    socket.onerror = () => {
      // onclose follows shortly. the browser prefers to deliver bad news twice.
    };
  }

  disconnect(): void {
    this.closedByUs = true;
    this.send({ type: 'leave' });
    this.socket?.close();
  }

  join(room: string): void {
    this.send({ type: 'join', room });
  }

  sendInput(frame: number, axisX: number, jump: boolean): void {
    // inputs are fire-and-forget; a late jump is a missed jump, not a queued one
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'input', frame, axisX, jump }));
    }
  }

  onMessage(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private send(msg: LobbyMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(msg));
    } else if (msg.type !== 'ping') {
      this.outbox.push(msg);
    }
  }

  private flush(): void {
    const pending = this.outbox.splice(0, this.outbox.length);
    for (const msg of pending) this.send(msg);
  }

  private scheduleReconnect(): void {
    const delay = Math.min(MAX_BACKOFF_MS, 500 * 2 ** this.attempts) + Math.random() * 250;
    this.attempts++;
    // the jitter exists so that 40 playtesters do not reconnect in perfect unison.
    // they will still complain in perfect unison.
    window.setTimeout(() => this.connect(), delay);
  }

  private parse(raw: unknown): ServerMessage | null {
    if (typeof raw !== 'string') return null;
    try {
      const msg = JSON.parse(raw) as ServerMessage;
      return typeof msg.type === 'string' ? msg : null;
    } catch {
      return null;
    }
  }
}
`;

SRC.GD_SAVE = `import { Vec2 } from '../math/vec2';

// ENG-402: save system.
// Three slots, versioned, checksummed. Corrupted saves are migrated, not deleted,
// because a deleted save is a support ticket with feelings.

const SAVE_VERSION = 3;
const SLOT_COUNT = 3;
const KEY_PREFIX = 'ember.save.';

export interface SaveData {
  version: number;
  level: string;
  playerPos: { x: number; y: number };
  health: number;
  coins: number;
  playtimeSeconds: number;
  savedAt: string;
}

interface Envelope {
  checksum: number;
  payload: string;
}

export class SaveSystem {
  constructor(private readonly storage: Storage = window.localStorage) {}

  save(slot: number, data: Omit<SaveData, 'version' | 'savedAt'>): void {
    this.assertSlot(slot);
    const full: SaveData = { ...data, version: SAVE_VERSION, savedAt: new Date().toISOString() };
    const payload = JSON.stringify(full);
    const envelope: Envelope = { checksum: fnv1a(payload), payload };
    this.storage.setItem(KEY_PREFIX + slot, JSON.stringify(envelope));
  }

  load(slot: number): SaveData | null {
    this.assertSlot(slot);
    const raw = this.storage.getItem(KEY_PREFIX + slot);
    if (!raw) return null;

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch {
      return null;
    }
    if (fnv1a(envelope.payload) !== envelope.checksum) {
      console.warn('save slot ' + slot + ' failed checksum; refusing to load it');
      return null;
    }
    return migrate(JSON.parse(envelope.payload));
  }

  listSlots(): Array<{ slot: number; data: SaveData | null }> {
    const slots = [];
    for (let slot = 0; slot < SLOT_COUNT; slot++) {
      slots.push({ slot, data: this.load(slot) });
    }
    return slots;
  }

  clear(slot: number): void {
    this.assertSlot(slot);
    this.storage.removeItem(KEY_PREFIX + slot);
  }

  playerPosition(data: SaveData): Vec2 {
    return new Vec2(data.playerPos.x, data.playerPos.y);
  }

  private assertSlot(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= SLOT_COUNT) {
      throw new RangeError('save slot out of range: ' + slot);
    }
  }
}

// Migrations run in order. Each one is small, boring and permanent.
function migrate(data: Record<string, unknown>): SaveData {
  let version = typeof data.version === 'number' ? data.version : 1;

  if (version === 1) {
    // v1 stored coins as a string. nobody remembers why. nobody is asking.
    data.coins = Number(data.coins ?? 0);
    version = 2;
  }
  if (version === 2) {
    data.playtimeSeconds = data.playtimeSeconds ?? 0;
    version = 3;
  }
  data.version = version;
  return data as unknown as SaveData;
}

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
`;

SRC.GD_AUDIO = `// ENG-467: audio mixer.
// Three buses: master, music, sfx. Ducking lowers the music when something
// important happens, such as a coin, which is the most important thing.

type Bus = 'music' | 'sfx';

const MUSIC_GAIN = 0.7;
const DUCK_GAIN = 0.35;
const DUCK_RELEASE_S = 0.6;
const CROSSFADE_S = 1.5;

export class AudioMixer {
  private readonly ctx: AudioContext;
  private readonly master: GainNode;
  private readonly buses: Record<Bus, GainNode>;
  private readonly buffers = new Map<string, AudioBuffer>();
  private currentMusic: AudioBufferSourceNode | null = null;
  private musicGain: GainNode | null = null;

  constructor(ctx: AudioContext = new AudioContext()) {
    this.ctx = ctx;
    this.master = ctx.createGain();
    this.master.connect(ctx.destination);
    this.buses = {
      music: this.makeBus(MUSIC_GAIN),
      sfx: this.makeBus(1.0),
    };
  }

  async load(name: string, url: string): Promise<void> {
    const res = await fetch(url);
    if (!res.ok) throw new Error('audio not found: ' + url);
    const data = await res.arrayBuffer();
    this.buffers.set(name, await this.ctx.decodeAudioData(data));
  }

  play(name: string, bus: Bus = 'sfx', pitchVariance = 0.08): void {
    const buffer = this.buffers.get(name);
    if (!buffer) return; // silence is a valid sound effect

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    // tiny random detune so 200 coins do not sound like one very long coin
    source.playbackRate.value = 1 + (Math.random() - 0.5) * 2 * pitchVariance;
    source.connect(this.buses[bus]);
    source.start();
    if (bus === 'sfx') this.duckMusic();
  }

  playMusic(name: string): void {
    const buffer = this.buffers.get(name);
    if (!buffer) return;
    const now = this.ctx.currentTime;

    if (this.currentMusic && this.musicGain) {
      this.musicGain.gain.linearRampToValueAtTime(0, now + CROSSFADE_S);
      this.currentMusic.stop(now + CROSSFADE_S);
    }

    const gain = this.ctx.createGain();
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(1, now + CROSSFADE_S);
    gain.connect(this.buses.music);

    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gain);
    source.start(now);

    this.currentMusic = source;
    this.musicGain = gain;
  }

  setVolume(bus: Bus | 'master', value: number): void {
    const node = bus === 'master' ? this.master : this.buses[bus];
    node.gain.setTargetAtTime(clamp01(value), this.ctx.currentTime, 0.02);
  }

  async resume(): Promise<void> {
    // browsers refuse to play audio until the user has clicked something.
    // this is the only place in the engine where we agree with the browser.
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  private makeBus(gain: number): GainNode {
    const node = this.ctx.createGain();
    node.gain.value = gain;
    node.connect(this.master);
    return node;
  }

  private duckMusic(): void {
    const music = this.buses.music.gain;
    const now = this.ctx.currentTime;
    music.cancelScheduledValues(now);
    music.setValueAtTime(DUCK_GAIN * MUSIC_GAIN, now);
    music.linearRampToValueAtTime(MUSIC_GAIN, now + DUCK_RELEASE_S);
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
`;

SRC.GD_CAMERA = `import { Vec2 } from '../math/vec2';

// Camera. Follows the player with a dead zone so the screen does not twitch
// every time the player breathes.

const FOLLOW_SPEED = 6;
const DEADZONE_W = 96;
const DEADZONE_H = 64;
const MAX_SHAKE = 24;

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class Camera {
  pos: Vec2;
  private shakeTime = 0;
  private shakeStrength = 0;
  private shakeOffset = new Vec2(0, 0);

  constructor(
    public viewportW: number,
    public viewportH: number,
    private readonly bounds: Bounds,
  ) {
    this.pos = new Vec2(bounds.minX + viewportW / 2, bounds.minY + viewportH / 2);
  }

  follow(target: Vec2, dt: number): void {
    const dx = target.x - this.pos.x;
    const dy = target.y - this.pos.y;
    const goalX = Math.abs(dx) > DEADZONE_W / 2 ? target.x - Math.sign(dx) * (DEADZONE_W / 2) : this.pos.x;
    const goalY = Math.abs(dy) > DEADZONE_H / 2 ? target.y - Math.sign(dy) * (DEADZONE_H / 2) : this.pos.y;

    const t = 1 - Math.exp(-FOLLOW_SPEED * dt); // frame-rate independent lerp
    this.pos = new Vec2(this.pos.x + (goalX - this.pos.x) * t, this.pos.y + (goalY - this.pos.y) * t);
    this.clampToBounds();
    this.updateShake(dt);
  }

  shake(strength: number, seconds: number): void {
    // additive, so a big explosion during a small explosion feels like a bigger explosion
    this.shakeStrength = Math.min(MAX_SHAKE, this.shakeStrength + strength);
    this.shakeTime = Math.max(this.shakeTime, seconds);
  }

  worldToScreen(world: Vec2): Vec2 {
    return new Vec2(
      world.x - this.pos.x + this.viewportW / 2 + this.shakeOffset.x,
      world.y - this.pos.y + this.viewportH / 2 + this.shakeOffset.y,
    );
  }

  screenToWorld(screen: Vec2): Vec2 {
    return new Vec2(screen.x + this.pos.x - this.viewportW / 2, screen.y + this.pos.y - this.viewportH / 2);
  }

  visibleRect(): { left: number; top: number; right: number; bottom: number } {
    const left = this.pos.x - this.viewportW / 2;
    const top = this.pos.y - this.viewportH / 2;
    return { left, top, right: left + this.viewportW, bottom: top + this.viewportH };
  }

  private clampToBounds(): void {
    const halfW = this.viewportW / 2;
    const halfH = this.viewportH / 2;
    this.pos.x = Math.max(this.bounds.minX + halfW, Math.min(this.bounds.maxX - halfW, this.pos.x));
    this.pos.y = Math.max(this.bounds.minY + halfH, Math.min(this.bounds.maxY - halfH, this.pos.y));
  }

  private updateShake(dt: number): void {
    if (this.shakeTime <= 0) {
      this.shakeOffset = new Vec2(0, 0);
      this.shakeStrength = 0;
      return;
    }
    this.shakeTime -= dt;
    // the shake decays with time so that a level ends quieter than it started
    const falloff = Math.max(0, this.shakeTime) * this.shakeStrength;
    this.shakeOffset = new Vec2((Math.random() - 0.5) * 2 * falloff, (Math.random() - 0.5) * 2 * falloff);
  }
}
`;

SRC.GD_ANIMATOR = `// Sprite animator. Frame counts and fps come from assets.manifest.json so the
// artists can retime a walk cycle without filing a ticket. They file one anyway.

export interface SpriteDef {
  frames: number;
  fps: number;
}

const TILE = 32;

export class SpriteAnimator {
  private current: string;
  private frame = 0;
  private elapsed = 0;
  private loop = true;
  private finished = false;
  flipX = false;

  constructor(private readonly sprites: Record<string, SpriteDef>, initial = 'player_idle') {
    if (!sprites[initial]) throw new Error('unknown sprite: ' + initial);
    this.current = initial;
  }

  play(name: string, loop = true): void {
    if (!this.sprites[name]) throw new Error('unknown sprite: ' + name);
    if (name === this.current && !this.finished) return; // already playing; do not restart every frame
    this.current = name;
    this.frame = 0;
    this.elapsed = 0;
    this.loop = loop;
    this.finished = false;
  }

  update(dt: number): void {
    if (this.finished) return;
    const def = this.def();
    const frameDuration = 1 / def.fps;
    this.elapsed += dt;

    while (this.elapsed >= frameDuration) {
      this.elapsed -= frameDuration;
      this.frame++;
      if (this.frame >= def.frames) {
        if (this.loop) {
          this.frame = 0;
        } else {
          this.frame = def.frames - 1;
          this.finished = true;
          break;
        }
      }
    }
  }

  isFinished(): boolean {
    return this.finished;
  }

  currentName(): string {
    return this.current;
  }

  /** Source rectangle in the atlas for the current frame. One sprite per atlas row. */
  sourceRect(): { sx: number; sy: number; sw: number; sh: number } {
    const row = Object.keys(this.sprites).indexOf(this.current);
    return { sx: this.frame * TILE, sy: row * TILE, sw: TILE, sh: TILE };
  }

  draw(ctx: CanvasRenderingContext2D, atlas: HTMLImageElement, x: number, y: number): void {
    const { sx, sy, sw, sh } = this.sourceRect();
    ctx.save();
    if (this.flipX) {
      // flip around the sprite's own centre, not the world origin.
      // the world origin was tried. the player teleported off the map.
      ctx.translate(x + sw, y);
      ctx.scale(-1, 1);
      ctx.drawImage(atlas, sx, sy, sw, sh, 0, 0, sw, sh);
    } else {
      ctx.drawImage(atlas, sx, sy, sw, sh, x, y, sw, sh);
    }
    ctx.restore();
  }

  private def(): SpriteDef {
    return this.sprites[this.current];
  }
}
`;

SRC.GD_TILEMAP = `import { Camera } from '../camera/camera';
import { Vec2 } from '../math/vec2';

// Tilemap renderer. Chunks of 16x16 tiles are baked to offscreen canvases once
// and blitted forever after. The GPU would like a word, but it is a 2D game.

const TILE_SIZE = 32;
const CHUNK_TILES = 16;
const CHUNK_PX = TILE_SIZE * CHUNK_TILES;

export class TilemapRenderer {
  private readonly chunks = new Map<string, HTMLCanvasElement>();
  private readonly rows: number;
  private readonly cols: number;

  constructor(private readonly tiles: number[][], private readonly tileset: HTMLImageElement) {
    this.rows = tiles.length;
    this.cols = tiles[0]?.length ?? 0;
  }

  draw(ctx: CanvasRenderingContext2D, camera: Camera): void {
    const view = camera.visibleRect();
    const firstCol = Math.max(0, Math.floor(view.left / CHUNK_PX));
    const lastCol = Math.floor(view.right / CHUNK_PX);
    const firstRow = Math.max(0, Math.floor(view.top / CHUNK_PX));
    const lastRow = Math.floor(view.bottom / CHUNK_PX);

    for (let cy = firstRow; cy <= lastRow; cy++) {
      for (let cx = firstCol; cx <= lastCol; cx++) {
        const chunk = this.chunk(cx, cy);
        if (!chunk) continue;
        const screen = camera.worldToScreen(new Vec2(cx * CHUNK_PX, cy * CHUNK_PX));
        // integer positions only; half-pixel tiles produce seams that QA can see from orbit
        ctx.drawImage(chunk, Math.round(screen.x), Math.round(screen.y));
      }
    }
  }

  invalidate(col: number, row: number): void {
    // a tile changed (destructible wall, opened door, over-enthusiastic level designer)
    this.chunks.delete(key(Math.floor(col / CHUNK_TILES), Math.floor(row / CHUNK_TILES)));
  }

  chunkCount(): number {
    return this.chunks.size;
  }

  private chunk(cx: number, cy: number): HTMLCanvasElement | null {
    if (cx * CHUNK_TILES >= this.cols || cy * CHUNK_TILES >= this.rows) return null;
    const k = key(cx, cy);
    const cached = this.chunks.get(k);
    if (cached) return cached;
    const baked = this.bake(cx, cy);
    this.chunks.set(k, baked);
    return baked;
  }

  private bake(cx: number, cy: number): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = CHUNK_PX;
    canvas.height = CHUNK_PX;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2d context unavailable for chunk bake');
    ctx.imageSmoothingEnabled = false; // pixels are supposed to look like pixels

    const tilesPerRow = Math.floor(this.tileset.width / TILE_SIZE);
    for (let ty = 0; ty < CHUNK_TILES; ty++) {
      const row = this.tiles[cy * CHUNK_TILES + ty];
      if (!row) break;
      for (let tx = 0; tx < CHUNK_TILES; tx++) {
        const id = row[cx * CHUNK_TILES + tx];
        if (!id) continue; // 0 is air. air is free.
        const sx = ((id - 1) % tilesPerRow) * TILE_SIZE;
        const sy = Math.floor((id - 1) / tilesPerRow) * TILE_SIZE;
        ctx.drawImage(this.tileset, sx, sy, TILE_SIZE, TILE_SIZE, tx * TILE_SIZE, ty * TILE_SIZE, TILE_SIZE, TILE_SIZE);
      }
    }
    return canvas;
  }
}

function key(cx: number, cy: number): string {
  return cx + ':' + cy;
}
`;

SRC.GD_MAIN = `import { Renderer } from './render/renderer';
import { PhysicsWorld } from './physics/physics.world';
import { ParticleSystem } from './particles/particle.system';
import { LevelLoader } from './levels/level.loader';
import { EnemyBrain } from './ai/enemy.ai';
import { initInput, axis, isDown } from './input/input.manager';
import { Vec2 } from './math/vec2';
import { Camera } from './camera/camera';
import { AudioMixer } from './audio/audio.mixer';
import { SaveSystem } from './save/save.system';
import { LobbyClient } from './net/lobby.client';
import { SpriteAnimator } from './anim/sprite.animator';
import { TilemapRenderer } from './tilemap/tilemap.renderer';

// Entry point for the playtest build. Wires everything together and then
// gets out of the way. The interesting code lives in the subsystems.

const WIDTH = 960;
const HEIGHT = 540;
const TILE_SIZE = 32;
const BENCH_FRAMES = 600;
const LOBBY_URL = 'wss://lobby.internal.corp/playtest';

async function boot(): Promise<void> {
  const canvas = document.getElementById('game') as HTMLCanvasElement;
  canvas.width = WIDTH;
  canvas.height = HEIGHT;
  const ctx2d = canvas.getContext('2d');
  if (!ctx2d) throw new Error('2d context unavailable');

  initInput();
  const renderer = new Renderer(canvas);
  const world = new PhysicsWorld();
  const particles = new ParticleSystem(new Vec2(0, 240));
  const audio = new AudioMixer();
  const saves = new SaveSystem();
  const lobby = new LobbyClient(LOBBY_URL, 'p_' + Math.random().toString(36).slice(2, 8));

  const level = await new LevelLoader().load('/levels/forest_01.json', world);
  const manifest = await (await fetch('/assets/assets.manifest.json')).json();
  const tileset = await loadImage('/assets/' + manifest.atlas);
  const tilemap = new TilemapRenderer(level.tiles, tileset);
  const camera = new Camera(WIDTH, HEIGHT, {
    minX: 0,
    minY: 0,
    maxX: level.tiles[0].length * TILE_SIZE,
    maxY: level.tiles.length * TILE_SIZE,
  });

  const spawn = level.spawns.find((s) => s.kind === 'player') ?? { x: 64, y: 64 };
  const saved = saves.load(0);
  const player = {
    pos: new Vec2(saved?.playerPos.x ?? spawn.x, saved?.playerPos.y ?? spawn.y),
    vel: new Vec2(0, 0),
    halfW: 12,
    halfH: 16,
    grounded: false,
    isStatic: false,
  };
  world.add(player);
  const playerSprite = new SpriteAnimator(manifest.sprites);

  const enemies = level.spawns
    .filter((s) => s.kind === 'slime')
    .map((s) => ({
      body: { pos: new Vec2(s.x, s.y), vel: new Vec2(0, 0), halfW: 14, halfH: 12, grounded: false, isStatic: false },
      health: 1,
      brain: new EnemyBrain(),
    }));
  for (const enemy of enemies) world.add(enemy.body);

  await Promise.all([
    audio.load('jump', '/assets/' + manifest.audio.jump),
    audio.load('coin', '/assets/' + manifest.audio.coin),
    audio.load('music_forest', '/assets/' + manifest.audio.music_forest),
  ]);
  window.addEventListener('pointerdown', () => audio.resume().then(() => audio.playMusic('music_forest')), { once: true });
  lobby.connect();

  const bench = new URLSearchParams(location.search).get('bench') === 'frame';
  let last = performance.now();
  let frame = 0;
  let benchFrames = 0;
  let fpsAccum = 0;
  let fpsFrames = 0;
  let fps = 0;

  function tick(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    // input -> physics -> ai -> particles -> camera -> draw. in that order, always.
    player.vel.x = axis('KeyA', 'KeyD') * 180;
    if (isDown('Space') && player.grounded) {
      player.vel.y = -420;
      audio.play('jump');
      particles.emit(player.pos, 12, 90, 30);
    }
    world.tick(dt);
    for (const enemy of enemies) {
      const wish = enemy.brain.think({ pos: enemy.body.pos, health: enemy.health }, player, dt);
      enemy.body.vel.x = wish.x;
    }
    particles.update(dt);
    camera.follow(player.pos, dt);
    playerSprite.play(Math.abs(player.vel.x) > 1 ? 'player_run' : 'player_idle');
    playerSprite.flipX = player.vel.x < 0;
    playerSprite.update(dt);

    renderer.clear(WIDTH, HEIGHT);
    tilemap.draw(ctx2d, camera);
    const screen = camera.worldToScreen(player.pos);
    playerSprite.draw(ctx2d, tileset, screen.x - player.halfW, screen.y - player.halfH);
    particles.render(renderer);
    lobby.sendInput(frame, player.vel.x, player.vel.y < 0);

    frame++;
    fpsFrames++;
    fpsAccum += dt;
    if (fpsAccum >= 1) {
      fps = Math.round(fpsFrames / fpsAccum);
      fpsFrames = 0;
      fpsAccum = 0;
      document.title = 'ember-engine — ' + fps + ' fps';
    }
    if (bench && ++benchFrames >= BENCH_FRAMES) {
      // npm run bench:frame reads this line from the console. it is the whole benchmark.
      console.log('bench:frame ' + fps + ' fps over ' + BENCH_FRAMES + ' frames');
      lobby.disconnect();
      return;
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image not found: ' + url));
    img.src = url;
  });
}

boot().catch((err) => {
  console.error('boot failed', err);
  document.body.textContent = 'The engine did not start. This is not the fun kind of crash.';
});
`;

SRC.GD_WATER = `// water.frag — surface ripple and refraction for the forest ponds.
// Reuses the fire noise texture, because the noise budget is one texture.

precision mediump float;

uniform sampler2D u_scene;
uniform sampler2D u_noise;
uniform float u_time;
uniform vec2 u_resolution;
uniform float u_waterline;

varying vec2 v_uv;

const float RIPPLE_SCALE = 6.0;
const float RIPPLE_SPEED = 0.4;
const float REFRACT_STRENGTH = 0.012;

vec2 ripple(vec2 uv) {
  float t = u_time * RIPPLE_SPEED;
  float a = texture2D(u_noise, uv * RIPPLE_SCALE + vec2(t, 0.0)).r;
  float b = texture2D(u_noise, uv * RIPPLE_SCALE * 1.7 - vec2(0.0, t * 1.3)).r;
  return (vec2(a, b) - 0.5) * 2.0;
}

void main() {
  vec2 uv = v_uv;
  if (uv.y < u_waterline) {
    // above the surface: pass the scene through untouched. water is polite.
    gl_FragColor = texture2D(u_scene, uv);
    return;
  }

  float depth = (uv.y - u_waterline) / (1.0 - u_waterline);
  vec2 offset = ripple(uv) * REFRACT_STRENGTH * (0.3 + depth);

  // reflect the world above the waterline, then wobble it
  vec2 mirrored = vec2(uv.x, u_waterline - (uv.y - u_waterline)) + offset;
  vec3 reflection = texture2D(u_scene, mirrored).rgb;
  vec3 underwater = texture2D(u_scene, uv + offset).rgb;

  vec3 tint = vec3(0.12, 0.32, 0.45);
  vec3 color = mix(reflection, underwater, 0.55);
  color = mix(color, tint, 0.35 + depth * 0.4);

  // highlight on the ripple crests. the art director calls this "sparkle".
  float crest = smoothstep(0.75, 0.95, ripple(uv * 0.5).x);
  color += vec3(crest * 0.25);

  gl_FragColor = vec4(color, 1.0);
}
`;

SRC.GD_ATLAS_PACKER = `#!/usr/bin/env python3
"""Atlas packer for ember-engine.

Reads assets/raw/<sprite>/<frame>.png, packs each sprite into one row of the
atlas and updates assets/assets.manifest.json with the frame counts.
Run it through: npm run assets:pack
"""
import argparse
import json
import sys
from pathlib import Path

from PIL import Image

TILE = 32
ATLAS_NAME = "atlas_main.png"


def discover_sprites(raw_dir: Path) -> dict:
    """Map sprite name -> sorted list of frame paths."""
    sprites = {}
    for folder in sorted(p for p in raw_dir.iterdir() if p.is_dir()):
        frames = sorted(folder.glob("*.png"))
        if not frames:
            print("warn: " + folder.name + " has no frames; skipping", file=sys.stderr)
            continue
        sprites[folder.name] = frames
    return sprites


def validate_frame(path: Path) -> Image.Image:
    img = Image.open(path).convert("RGBA")
    if img.size != (TILE, TILE):
        # the artists were told 32x32. the artists were told many things.
        raise SystemExit("frame " + str(path) + " is " + str(img.size) + ", expected " + str((TILE, TILE)))
    return img


def pack(sprites: dict) -> Image.Image:
    rows = len(sprites)
    cols = max(len(frames) for frames in sprites.values())
    atlas = Image.new("RGBA", (cols * TILE, rows * TILE), (0, 0, 0, 0))

    for row, (name, frames) in enumerate(sprites.items()):
        for col, frame_path in enumerate(frames):
            atlas.paste(validate_frame(frame_path), (col * TILE, row * TILE))
        print("packed " + name + ": " + str(len(frames)) + " frames")
    return atlas


def update_manifest(manifest_path: Path, sprites: dict) -> None:
    with open(manifest_path) as fh:
        manifest = json.load(fh)

    existing = manifest.setdefault("sprites", {})
    for name, frames in sprites.items():
        entry = existing.setdefault(name, {"fps": 10})
        entry["frames"] = len(frames)
        # fps is hand-tuned in the manifest; the packer never overwrites it.
        # overwriting it once cost a week of "why does the slime look nervous".

    manifest["atlas"] = ATLAS_NAME
    manifest["tileSize"] = TILE
    with open(manifest_path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\\n")


def main() -> int:
    parser = argparse.ArgumentParser(description="pack raw sprite frames into the atlas")
    parser.add_argument("raw_dir", type=Path)
    parser.add_argument("out_path", type=Path)
    parser.add_argument("--manifest", type=Path, default=Path("assets/assets.manifest.json"))
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    sprites = discover_sprites(args.raw_dir)
    if not sprites:
        print("nothing to pack in " + str(args.raw_dir), file=sys.stderr)
        return 1

    atlas = pack(sprites)
    if args.dry_run:
        print("dry run: atlas would be " + str(atlas.size))
        return 0

    args.out_path.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(args.out_path, optimize=True)
    update_manifest(args.manifest, sprites)
    print("wrote " + str(args.out_path) + " (" + str(atlas.size[0]) + "x" + str(atlas.size[1]) + ")")
    return 0


if __name__ == "__main__":
    sys.exit(main())
`;

SRC.GD_FOREST_LEVEL = `{
  "name": "forest_01",
  "gravity": 980,
  "tileset": "atlas_main.png",
  "music": "music_forest",
  "notes": "Tutorial level. If playtesters die here, the level is wrong, not the playtesters.",
  "legend": { "0": "air", "1": "solid", "2": "grass (decor)", "3": "water (see shaders/water.frag)" },
  "tiles": [
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 2, 2, 2, 2, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 2, 2, 2, 1],
    [1, 1, 1, 1, 1, 1, 3, 3, 3, 3, 1, 1, 1, 1, 1, 1, 1, 3, 3, 3, 1, 1, 1, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
  ],
  "spawns": [
    { "x": 64, "y": 336, "kind": "player" },
    { "x": 400, "y": 340, "kind": "slime" },
    { "x": 704, "y": 340, "kind": "slime" },
    { "x": 496, "y": 240, "kind": "slime" },
    { "x": 320, "y": 48, "kind": "coin" },
    { "x": 352, "y": 48, "kind": "coin" },
    { "x": 512, "y": 112, "kind": "coin" },
    { "x": 160, "y": 176, "kind": "coin" },
    { "x": 672, "y": 176, "kind": "coin" },
    { "x": 96, "y": 304, "kind": "torch" },
    { "x": 672, "y": 304, "kind": "torch" }
  ],
  "waterline": 0.857
}
`;

SRC.GD_ENEMY_SPEC = `import { EnemyBrain } from '../enemy.ai';
import { Vec2 } from '../../math/vec2';

// Enemy AI is a state machine, so these tests are mostly about where the lines are drawn.

function actor(x: number, y: number, health = 1) {
  return { pos: new Vec2(x, y), health };
}

describe('EnemyBrain', () => {
  it('patrols horizontally when the player is out of sight', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(0, 0), actor(1000, 0), 1 / 60);
    expect(move.y).toBe(0);
    expect(Math.abs(move.x)).toBe(40);
  });

  it('chases when the player is within sight range', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(0, 0), actor(200, 0), 1 / 60);
    expect(move.x).toBeGreaterThan(0);
    expect(move.length()).toBeCloseTo(90, 3);
  });

  it('stops moving inside attack range', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(0, 0), actor(30, 0), 1 / 60);
    expect(move.x).toBe(0);
    expect(move.y).toBe(0);
  });

  it('flees away from the player when badly hurt', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(0, 0, 0.1), actor(100, 0), 1 / 60);
    // courage is a resource and this one has run out
    expect(move.x).toBeLessThan(0);
    expect(move.length()).toBeCloseTo(120, 3);
  });

  it('prefers fleeing over attacking at low health', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(0, 0, 0.2), actor(20, 0), 1 / 60);
    expect(move.x).toBeLessThan(0);
  });

  it('never returns NaN when standing on top of the player', () => {
    const brain = new EnemyBrain();
    const move = brain.think(actor(50, 50), actor(50, 50), 1 / 60);
    expect(Number.isNaN(move.x)).toBe(false);
    expect(Number.isNaN(move.y)).toBe(false);
  });
});
`;

SRC.GD_PACKAGE_JSON = `{
  "name": "ember-engine",
  "version": "0.9.4",
  "private": true,
  "description": "In-house 2D engine for the untitled roguelike.",
  "scripts": {
    "dev": "vite --host",
    "build": "tsc -p tsconfig.json --noEmit && vite build",
    "test": "jest --colors",
    "lint": "eslint src --ext .ts",
    "assets:pack": "python tools/atlas_packer.py assets/raw assets/atlas_main.png",
    "shaders:compile": "glslangValidator shaders/*.frag",
    "bench:frame": "vite preview --open /playtest?bench=frame"
  },
  "devDependencies": {
    "@types/jest": "^29.5.12",
    "eslint": "^8.57.0",
    "jest": "^29.7.0",
    "ts-jest": "^29.1.2",
    "typescript": "^5.4.0",
    "vite": "^5.2.8"
  },
  "engines": {
    "node": ">=20"
  }
}
`;

PROFILES.register({
  id: 'gamedev',
  label: 'Game development',
  stack: 'WebGL engine · TypeScript + GLSL',
  desc: 'A 2D engine: particles, physics, enemy AI, shaders and an asset pipeline.',
  project: 'ember-engine',
  version: '0.9.4',
  branch: 'feature/ENG-451-particles',
  remote: 'github.internal.corp:studio/ember-engine',
  image: 'registry.internal.corp/studio/ember-engine',
  deployName: 'ember-playtest',
  namespace: 'playtest',
  dbLine: null,
  migrateLines: [],
  primaryLang: 'ts',
  checker: 'tsc',
  checkFiles: 118,
  termproc: 'node — ember-engine',
  hmrPath: '/src/particles/particle.system.ts',
  shell: { user: 'dev', host: 'studio-pc', pkg: 'npm' },
  ports: [[5173, 'vite playtest', 'node'], [24678, 'vite hmr', 'node'], [9229, 'inspector', 'node']],
  scripts: [
    ['dev', 'vite --host'],
    ['build', 'tsc -p tsconfig.json --noEmit && vite build'],
    ['test', 'jest --colors'],
    ['lint', 'eslint src --ext .ts'],
    ['assets:pack', 'python tools/atlas_packer.py assets/raw assets/atlas_main.png'],
    ['shaders:compile', 'glslangValidator shaders/*.frag'],
    ['bench:frame', 'vite preview --open /playtest?bench=frame'],
  ],
  branches: ['main', 'develop', 'feature/ENG-451-particles', 'feature/ENG-433-lobby', 'fix/ENG-470-wall-stick', 'release/0.9'],
  commits: [
    ['a41c9e2', 'feat(particles): swap-remove dead particles instead of splice', 'Marta Lindqvist', '3 hours ago'],
    ['7d0b3f1', 'perf(particles): preallocate pool, drop per-frame allocations (ENG-451)', 'Marta Lindqvist', '6 hours ago'],
    ['c92e410', 'fix(physics): resolve along shallow axis to stop wall-sticking', 'Tomasz Brenner', 'yesterday'],
    ['58f7a0c', 'feat(net): lobby client with backoff and heartbeat (ENG-433)', 'Ines Okafor', 'yesterday'],
    ['e1b4d77', 'feat(save): versioned save slots with checksum (ENG-402)', 'Tomasz Brenner', '2 days ago'],
    ['3fa9c15', 'shaders: water refraction pass for the forest ponds', 'Yara Castellanos', '2 days ago'],
    ['b06e2d8', 'chore(tools): atlas packer refuses non-32px frames', 'Ines Okafor', '3 days ago'],
    ['9c3d51a', 'feat(camera): dead zone follow and additive shake', 'Marta Lindqvist', '4 days ago'],
    ['f70a8b3', 'fix(audio): duck music on sfx, release over 600ms (ENG-467)', 'Yara Castellanos', '5 days ago'],
    ['2ee1c04', 'levels: forest_01 tutorial layout v3', 'Tomasz Brenner', '6 days ago'],
  ],
  lintFiles: [
    ['src/render/renderer.ts', '17:33  Unexpected magic number: 90', 'no-magic-numbers'],
    ['src/particles/particle.system.ts', '23:91  Line exceeds maximum length of 90', 'max-len'],
    ['src/net/lobby.client.ts', '62:22  Unexpected empty arrow function', 'no-empty-function'],
  ],
  suites: [
    ['src/physics/__tests__/physics.world.spec.ts', 8, 12],
    ['src/particles/__tests__/particle.system.spec.ts', 6, 10],
    ['src/ai/__tests__/enemy.ai.spec.ts', 5, 7],
  ],
  jobs: ['typecheck', 'jest', 'vitebuild', 'eslint', 'npminstall', 'gitfetch', 'hmr', 'atlas', 'shaderc', 'fps'],
  bootLines: [
    '<span class="mag">$</span> npm run dev',
    '<span class="dim">&gt; ember-engine@0.9.4 dev</span>',
    '<span class="dim">&gt; vite --host</span>',
    '',
    '  <span class="ok">VITE v5.2.8</span>  <span class="dim">ready in 512 ms</span>',
    '',
    '  <span class="ok">➜</span>  <span class="dim">Local:</span>   <span class="info">http://localhost:5173/playtest</span>',
    '  <span class="dim">watching for file changes...</span>',
  ],
  debug: {
    conf: 'Launch playtest (chrome)',
    vars: [['dt', '0.0166'], ['alive', '2913'], ['gravity', '{ x: 0, y: 980 }'], ['fps', '143']],
    watch: [['pool.length', '4096'], ['player.grounded', 'true']],
    stack: ['ParticleSystem.update  particle.system.ts:44', 'PhysicsWorld.step  physics.world.ts:39', 'requestAnimationFrame  (native)'],
  },
  files: () => [
    ['src/particles/particle.system.ts', genLargeTsClass(SRC.GD_PARTICLE, 'ParticleSystem', 'particle simulation', ['validateEmitter', 'normalizeBurst', 'allocateParticles', 'integrateFrame', 'reclaimParticles', 'publishMetrics'], 1100), true],
    ['src/physics/physics.world.ts', genLargeTsClass(SRC.GD_PHYSICS, 'PhysicsWorld', 'physics step', ['validateBody', 'integrateVelocity', 'broadphase', 'narrowphase', 'resolveContact', 'publishFrameStats'], 600), true],
    ['shaders/fire.frag', SRC.GD_SHADER, true],
    ['src/levels/level.loader.ts', SRC.GD_LEVEL, true],
    ['src/ai/enemy.ai.ts', SRC.GD_ENEMY, true],
    ['src/net/lobby.client.ts', SRC.GD_LOBBY, true],
    ['src/save/save.system.ts', SRC.GD_SAVE, true],
    ['src/render/renderer.ts', SRC.GD_RENDERER],
    ['src/input/input.manager.ts', SRC.GD_INPUT],
    ['src/math/vec2.ts', SRC.GD_VEC2],
    ['src/audio/audio.mixer.ts', SRC.GD_AUDIO],
    ['src/camera/camera.ts', SRC.GD_CAMERA],
    ['src/anim/sprite.animator.ts', SRC.GD_ANIMATOR],
    ['src/tilemap/tilemap.renderer.ts', SRC.GD_TILEMAP],
    ['src/main.ts', SRC.GD_MAIN],
    ['shaders/water.frag', SRC.GD_WATER],
    ['tools/atlas_packer.py', SRC.GD_ATLAS_PACKER],
    ['levels/forest_01.json', SRC.GD_FOREST_LEVEL],
    ['assets/assets.manifest.json', SRC.GD_MANIFEST],
    ['src/physics/__tests__/physics.world.spec.ts', genSpec('PhysicsWorld', '../physics.world', ['resolves overlaps along the shallow axis', 'marks bodies grounded on floor contact', 'survives a spiral-of-death frame'])],
    ['src/particles/__tests__/particle.system.spec.ts', genSpec('ParticleSystem', '../particle.system', ['never exceeds the particle pool', 'swap-removes dead particles', 'fades particles by remaining life'])],
    ['src/ai/__tests__/enemy.ai.spec.ts', SRC.GD_ENEMY_SPEC],
    ['package.json', SRC.GD_PACKAGE_JSON],
    ['tsconfig.json', genTsconfig()],
    ['.github/ci.yml', genCi('ember-engine')],
    ['README.md', genReadme('ember-engine', 'In-house 2D engine for the untitled roguelike. Runs at 143 fps out of spite.', ['TypeScript + WebGL', 'GLSL shaders', 'Fixed-timestep physics', 'JSON levels (the editor is a spreadsheet)'])],
  ],
  tree: () => [
    d('.github', [fnode('.github/ci.yml')]),
    d('assets', [fnode('assets/assets.manifest.json')], true),
    d('levels', [fnode('levels/forest_01.json')], true),
    d('shaders', [fnode('shaders/fire.frag'), fnode('shaders/water.frag')], true),
    d('src', [
      d('ai', [
        d('__tests__', [fnode('src/ai/__tests__/enemy.ai.spec.ts')]),
        fnode('src/ai/enemy.ai.ts'),
      ], true),
      d('anim', [fnode('src/anim/sprite.animator.ts')]),
      d('audio', [fnode('src/audio/audio.mixer.ts')]),
      d('camera', [fnode('src/camera/camera.ts')]),
      d('input', [fnode('src/input/input.manager.ts')]),
      d('levels', [fnode('src/levels/level.loader.ts')], true),
      d('math', [fnode('src/math/vec2.ts')]),
      d('net', [fnode('src/net/lobby.client.ts')], true),
      d('particles', [
        d('__tests__', [fnode('src/particles/__tests__/particle.system.spec.ts')]),
        fnode('src/particles/particle.system.ts'),
      ], true),
      d('physics', [
        d('__tests__', [fnode('src/physics/__tests__/physics.world.spec.ts')]),
        fnode('src/physics/physics.world.ts'),
      ], true),
      d('render', [fnode('src/render/renderer.ts')], true),
      d('save', [fnode('src/save/save.system.ts')], true),
      d('tilemap', [fnode('src/tilemap/tilemap.renderer.ts')]),
      fnode('src/main.ts'),
    ], true),
    d('tools', [fnode('tools/atlas_packer.py')]),
    d('node_modules', [d('vite', []), d('typescript', []), d('left-pad', [])]),
    fnode('package.json'), fnode('tsconfig.json'), fnode('README.md'),
  ],
});
})();
