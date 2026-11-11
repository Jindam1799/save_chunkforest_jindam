/* 메인 전투 씬: 이동 · 점프 · 포물선 씨앗탄 · 봉인 · 구체 날리기 · 연쇄 처치 */
(function () {
  'use strict';
  const DT = window.DT;
  const T = DT.TUNING;

  class GameScene extends Phaser.Scene {
    constructor() { super('Game'); }

    init(data) {
      this.run = (data && data.run) || DT.newRun('tuk');
      this.S = this.run.stats;
      Object.keys(DT.BASE_STATS).forEach(k => { if (this.S[k] === undefined) this.S[k] = DT.BASE_STATS[k]; });
      this.hero = this.run.hero;
      this.heroDef = DT.HEROES.find(h => h.id === this.hero) || DT.HEROES[0];
      this.stageIndex = this.run.stage || 0;
      this.score = this.run.score || 0;
      this.hp = Math.min(this.run.hp || this.S.maxHp, this.S.maxHp);
      this.learned = (this.run.learned || []).slice();
      this.maxCombo = this.run.maxCombo || 0;
    }

    create() {
      DT.setupCamera(this);
      this.stage = DT.DATA.stages[this.stageIndex];
      this.climb = this.stage.climb || null;
      // 씬 객체는 재사용되므로 스테이지별 상태를 매번 초기화
      this.boss = null; this.goal = null; this.crumbles = null; this.chestSpots = null; this.chestHint = false; this.movers = null; this.moverSprites = []; this.spikes = null;
      this.gates = []; this.climbQuiz = null; this.hazardMul = 1; this.hudTime = null; this.shieldLeft = this.S.shield || 0; this.hurryTime = T.HURRY_TIME + (this.S.timeBonus || 0);
      this.hazard = null; this.hazardBody = null; this.riding = null; this.lastSec = undefined; this.carried = null;
      this.lastCombo = null; this.pauseBox = null; this.flag = null; this.ambientFx = null;
      this.mapH = this.stage.map.length * DT.TILE;
      this.physics.world.setBounds(0, 0, DT.W, this.mapH);
      // 바닥에 구멍이 있는 맵: 아래로 떨어지면 맨 위에서 다시 떨어짐 (아래쪽 경계는 열어 둠)
      this.wrap = !!this.stage.wrap;
      this.physics.world.setBoundsCollision(true, true, true, !this.wrap);
      // 화면에 고정되는 UI 레이어 (세로로 스크롤되는 등반 맵에서도 HUD가 그대로)
      this.ui = this.add.container(0, 0).setDepth(60);
      this.physics.world.gravity.y = T.GRAVITY;

      // 상태값
      this.facing = 1;
      this.lastGroundAt = -1e9; this.jumpBufferUntil = 0; this.jumping = false;
      this.nextFireAt = 0; this.shootPoseUntil = 0; this.invUntil = 0; this.hurtUntil = 0; this.knockUntil = 0;
      this.powerUntil = 0; this.wasOnGround = true; this.airStart = 0;
      this.started = false; this.cleared = false; this.dead = false; this.isPaused = false; this.hurry = false;
      this.fireLocked = true; this.controlLocked = false; this.winPose = false; this.hitStopping = false;
      this.chainCombo = 0; this.chainUntil = 0;
      this.strikeUntil = 0; this.dropUntil = 0; this.pushing = false; this.dropkick = false; this.dk = null;
      this.inventory = []; this.completed = new Set(); this.dropIndex = 0;
      this.hudCache = {};

      this.theme = DT.THEMES[this.stage.theme] ? this.stage.theme : 'forest';
      this.bg = this.add.image(0, 0, 'bg_' + this.theme).setOrigin(0).setDepth(-10);
      this.terrain = [];
      this.spawns = [];
      this.buildMap();
      this.buildDropQueue();

      // 오브젝트 그룹
      this.seeds = this.physics.add.group();
      this.enemies = this.physics.add.group();
      this.frags = this.physics.add.group();
      this.waves = this.physics.add.group();
      this.eshots = this.physics.add.group();   // 몬스터·보스가 쏜 탄
      this.poops = this.physics.add.group();    // 똥강아지가 남긴 똥
      this.createFx();
      this.createPlayer();
      this.spawns.forEach(s => this.spawnEnemy(s));
      this.stageEnemyTotal = this.spawns.length;
      if (this.stage.boss) this.createBoss(this.stage.boss);

      // 충돌
      // ↓ + 점프: 발판 아래로 내려가기 (일방향 발판만 통과, 바닥·벽은 그대로)
      this.physics.add.collider(this.player, this.terrain, null, (a, b) => {
        const z = a === this.player ? b : a;
        return !this.dead && !(z.oneWay && this.time.now < this.dropUntil) && !this.slopeStep(this.player, z, this.onSlope);
      });
      this.physics.add.collider(this.enemies, this.terrain, null, (a, b) => { const e = a.kind ? a : b, z = a.kind ? b : a; return e.state !== 'dead' && !(z.oneWay && this.time.now < (e.dropUntil || 0)) && !this.slopeStep(e, z); });
      this.physics.add.collider(this.seeds, this.terrain, (a, b) => this.popSeed(a.isSeed ? a : b));
      this.physics.add.collider(this.frags, this.terrain);
      this.physics.add.collider(this.waves, this.terrain);
      this.physics.add.collider(this.eshots, this.terrain, (a, b) => { const sh = a.isShot ? a : b; this.popShot(sh); },
        (a, b) => { const sh = a.isShot ? a : b, z = a.isShot ? b : a; return !(sh.solidOnly && z.oneWay); });
      this.physics.add.collider(this.poops, this.terrain);
      this.physics.add.overlap(this.player, this.eshots, (a, b) => {
        const sh = a.isShot ? a : b;
        if (!sh.active || this.dead || this.cleared || this.time.now < this.invUntil) return;
        this.popShot(sh); this.hurtPlayer(sh);
      });
      this.physics.add.overlap(this.player, this.poops, (a, b) => {
        const pp = a.isPoop ? a : b;
        if (!pp.active || this.dead || this.cleared || this.time.now < this.invUntil) return;
        this.popText(pp.x, pp.y - 10, '으악, 똥!', 0x8a4b2a);
        DT.Audio.sfx('squish');
        this.fxDust.explode(6, pp.x, pp.y);
        pp.destroy();
        this.hurtPlayer(pp);
      });
      this.physics.add.overlap(this.seeds, this.eshots, (a, b) => {
        const sd = a.isSeed ? a : b, sh = a.isSeed ? b : a;
        if (!sd.active || !sh.active || sh.unbreakable) return;
        sd.destroy(); this.popShot(sh); this.addScore(20);
      });
      this.physics.add.overlap(this.waves, this.enemies, (a, b) => { const w = a.isWave ? a : b, e = a.isWave ? b : a; this.waveHit(w, e); });
      this.physics.add.overlap(this.seeds, this.enemies, this.onSeedEnemy, (a, b) => { const e = a.isSeed ? b : a; return e.state === 'active' || e.state === 'sealed'; }, this);
      this.physics.add.collider(this.player, this.enemies, null, (a, b) => { const e = a === this.player ? b : a; return e.state === 'sealed' && !this.dead; });
      this.physics.add.overlap(this.player, this.enemies, this.onPlayerEnemy, null, this);
      this.physics.add.overlap(this.enemies, this.enemies, this.onEnemyEnemy, null, this);
      this.physics.add.overlap(this.player, this.frags, this.onCollect, null, this);
      this.physics.add.overlap(this.enemies, this.frags, this.onEnemyFrag, null, this);

      this.buildChests();
      this.buildHud();
      if (this.climb) this.setupClimb();
      else if (!this.stage.boss) {
        // 일반 스테이지: TIME 50 → 0이 되면 HURRY UP! (몬스터가 빨라짐)
        this.hudTime = DT.ptext(this, 172, 1, 'TIME ' + Math.round(this.hurryTime / 1000), { tint: 0xffcd75, depth: 41 });
        this.ui.add(this.hudTime);
      }
      this.readySequence();
      this.musicSpec = this.stage.boss ? { boss: this.stage.world } : { stage: this.stageIndex, world: this.stage.world, climb: !!this.climb };
      DT.Audio.music(true, this.musicSpec);
    }

    /* ───────────── 맵 ───────────── */
    buildMap() {
      const map = this.stage.map, S = DT.TILE;
      const at = (r, c) => (map[r] && map[r][c]) || '.';
      const rng = DT.rng(this.stageIndex * 97 + 13);
      this.slopes = {};
      for (let r = 0; r < map.length; r++) {
        for (let c = 0; c < map[r].length; c++) {
          const ch = map[r][c];
          const x = c * S, y = r * S;
          if (ch === '#') {
            const top = r > 0 && at(r - 1, c) !== '#';
            this.add.image(x, y, (top ? 'groundTop_' : 'stone_') + this.theme, Math.floor(rng() * 4)).setOrigin(0).setDepth(-2);
          } else if (ch === '=' || ch === 'G') {
            if (ch === 'G') this.goal = { x: x + 8, y };
            const isP = (q) => q === '=' || q === 'G';
            const l = !isP(at(r, c - 1)), rr = !isP(at(r, c + 1));
            const key = l && rr ? 'platLR' : l ? 'platL' : rr ? 'platR' : 'plat';
            this.add.image(x, y, key + '_' + this.theme, key === 'plat' ? Math.floor(rng() * 4) : 0).setOrigin(0).setDepth(-2);
            // 장식
            const roll = rng();
            const green = this.theme !== 'jiuzhaigou';
            if (green && roll < 0.22) this.add.image(x + 4 + Math.floor(rng() * 6), y, 'deco_tuft').setOrigin(0, 1).setDepth(-3);
            else if (this.theme === 'forest' && roll < 0.3) this.add.image(x + 5 + Math.floor(rng() * 5), y, 'deco_shroom').setOrigin(0, 1).setDepth(-3);
            else if (roll < 0.4) this.add.image(x + 6, y, rng() < 0.5 ? 'deco_flower' : 'deco_flower2').setOrigin(0, 1).setDepth(-3);
          } else if (ch === '^') {
            const sp = this.physics.add.staticImage(x + 8, y + 12, 'spikes_' + (this.theme === 'jiuzhaigou' || this.theme === 'zhangjiajie' ? 'b' : 'a')).setDepth(-1);
            sp.body.setSize(14, 6).setOffset(1, 2);
            (this.spikes = this.spikes || []).push(sp);
          } else if (ch === '/' || ch === '\\') {
            this.slopes[r + ',' + c] = ch;
          } else if (ch === 'C') {
            const t = this.physics.add.staticImage(x + 8, y + 4, 'crumble_' + this.theme).setDepth(-2);
            t.body.setSize(16, 8); t.body.checkCollision.down = t.body.checkCollision.left = t.body.checkCollision.right = false;
            t.crumble = true; t.home = { x: x + 8, y: y + 4 };
            (this.crumbles = this.crumbles || []).push(t);
          } else if (ch === 'M') {
            (this.movers = this.movers || []).push({ x: x + 8, y: y + 4 });
          } else if (ch === 'T') {
            (this.chestSpots = this.chestSpots || []).push({ x: x + 8, y: y + 16 });
          } else if (ch === 'P') {
            this.playerSpawn = { x: x + 8, y: y + 16 - 8 * DT.SPR - 0.5 };
          } else if (DT.ENEMY_CODES[ch]) {
            const kind = DT.ENEMY_CODES[ch];
            this.spawns.push({ kind, x: x + 8, y: DT.ENEMY_DEFS[kind].fly ? y + 8 : y + 16 - 8 * DT.SPR - 0.5 });
          }
        }
      }
      this.drawSlopes();
      // 물리 바디: 벽은 직사각형으로 병합, 발판은 위에서만 밟히는 일방향
      const runs = [];
      for (let r = 0; r < map.length; r++) {
        let c = 0;
        while (c < 20) {
          let ch = at(r, c);
          if (ch === 'G') ch = '=';
          if (ch === '#' || ch === '=') {
            const same = (q) => (q === 'G' ? '=' : q) === ch;
            let e = c; while (same(at(r, e + 1))) e++;
            runs.push({ ch, r, c0: c, c1: e, h: 1 });
            c = e + 1;
          } else c++;
        }
      }
      const solids = runs.filter(u => u.ch === '#');
      const merged = [];
      solids.forEach(u => {
        const prev = merged.find(m => m.c0 === u.c0 && m.c1 === u.c1 && m.r + m.h === u.r);
        if (prev) prev.h++; else merged.push(Object.assign({}, u));
      });
      merged.forEach(m => this.addBody(m.c0 * S, m.r * S, (m.c1 - m.c0 + 1) * S, m.h * S, false));
      runs.filter(u => u.ch === '=').forEach(u => this.addBody(u.c0 * S, u.r * S, (u.c1 - u.c0 + 1) * S, 8, true));
    }

    /* ── 경사로(45도): 오르막·내리막. 위에서만 밟히고, 내려갈 땐 미끄러짐 ── */
    drawSlopes() {
      const keys = Object.keys(this.slopes);
      if (!keys.length) return;
      const key = 'slopes_' + this.stageIndex;
      if (this.textures.exists(key)) this.textures.remove(key);
      const tex = this.textures.createCanvas(key, DT.W, this.mapH), ctx = tex.getContext();
      const T2 = DT.THEMES[this.theme], [body, spk, hi] = T2.plat, [t0, t1, t2] = T2.top;
      const px = (x, y, col) => { ctx.fillStyle = col; ctx.fillRect(x, y, 1, 1); };
      keys.forEach(k => {
        const [r, c] = k.split(',').map(Number), ch = this.slopes[k];
        for (let lx = 0; lx < 16; lx++) {
          const x = c * 16 + lx, sY = this.slopeSurfaceY(ch, r, lx);
          px(x, sY, t0); px(x, sY + 1, t1); px(x, sY + 2, t1); px(x, sY + 3, (x % 3) ? t1 : t2);
          for (let y = 4; y < 8; y++) px(x, sY + y, ((x + y) % 5 === 0) ? spk : ((x * 7 + y) % 11 === 0 ? hi : body));
          px(x, sY + 8, '#1a1c2c');
        }
      });
      tex.refresh();
      this.add.image(0, 0, key).setOrigin(0).setDepth(-2);
    }
    slopeSurfaceY(ch, r, lx) { return ch === '/' ? r * 16 + 15 - lx : r * 16 + lx; }
    // (x, 발밑 y)에서 경사로 표면 찾기
    slopeAt(x, yb, tol) {
      tol = tol || 0;
      const c = Math.floor(x / 16), lx = Math.floor(x) - c * 16;
      const r0 = Math.floor(yb / 16);
      for (let r = r0 - 1; r <= r0 + 1; r++) {
        const ch = this.slopes[r + ',' + c];
        if (!ch) continue;
        const sY = this.slopeSurfaceY(ch, r, lx);
        if (yb >= sY - 5 - tol && yb <= sY + 9 + tol) return { s: sY, down: ch === '/' ? -1 : 1, r, c };
      }
      return null;
    }
    // 경사로를 타고 올라오다 꼭대기 블록 모서리에 옆으로 부딪히는 것 무시 (경사로 보정이 곧 블록 위로 올려 줌)
    slopeStep(o, z, on) {
      if (!(on || o.onSlope) || !z.body) return false;
      const top = z.body.top, bot = o.body.bottom;
      return top < bot && top >= bot - 20;
    }

    // 점(x,y)이 경사로 띠(표면~두께) 안에 있는지
    slopeHit(x, y) {
      const c = Math.floor(x / 16), lx = Math.floor(x) - c * 16, r0 = Math.floor(y / 16);
      for (let r = r0 - 1; r <= r0; r++) {
        const ch = this.slopes[r + ',' + c];
        if (!ch) continue;
        const sY = this.slopeSurfaceY(ch, r, lx);
        if (y >= sY - 1 && y <= sY + 9) return true;
      }
      return false;
    }
    // 몸이 경사로 위에 있으면 표면에 붙임 (아래에서 위로 뛰어오를 때는 통과)
    // wasOn: 지난 프레임에도 경사로 위였으면 판정 폭을 넓힘 (빠르게 구르거나 프레임이 떨어져도 경사로를 놓치지 않게)
    // force: 구체(굴러가는·봉인)는 위로 살짝 튀어도 경사로를 타야 함 (밑으로 빠지지 않게)
    stickToSlope(body, wasOn, force) {
      if (!body || !body.enable || (body.velocity.y < -1 && !force)) return null;
      const hit = this.slopeAt(body.center.x, body.bottom, wasOn ? 9 : 0);
      if (!hit) return null;
      // 경사로 꼭대기가 블록·발판과 이어지는 곳: 앞발이 그 위에 올라서 있으면 그 높이로 (블록 모서리에 발이 끼어 멈추던 문제)
      const m = this.stage.map, top = hit.r * 16, side = hit.down < 0 ? 1 : -1;   // '/'는 오른쪽, '\'는 왼쪽이 오르막
      const nb = m[hit.r] && m[hit.r][hit.c + side];
      const footIn = side > 0 ? body.right > (hit.c + 1) * 16 - 3 : body.left < hit.c * 16 + 3;
      const above = m[hit.r - 1] && m[hit.r - 1][hit.c + side];   // 그 블록 위가 비어 있어야(서 있을 수 있는 윗면) 올라섬 — 바깥 벽 옆에서 벽을 타고 오르지 않게
      if (footIn && nb && '#=GC'.indexOf(nb) >= 0 && above && '#=GC/\\'.indexOf(above) < 0) hit.s = Math.min(hit.s, top);
      body.y = hit.s - body.height;
      if (body.velocity.y > 0) body.velocity.y = 0;
      return hit;
    }
    // 경사로 아래쪽(밑면)은 벽: 옆에서 걸어 들어와 비스듬한 발판을 뚫고 지나가지 못하게 밀어냄
    // (점프로 아래에서 위로 올라갈 때는 다른 발판처럼 통과)
    blockSlopeUnderside(body) {
      if (!body || !body.enable || body.velocity.y < -1) return;
      const y0 = body.top, y1 = body.bottom, r0 = Math.floor(y0 / 16) - 1, r1 = Math.floor(y1 / 16) + 1;
      const test = (ch, x) => {
        const c = Math.floor(x / 16), lx = Math.floor(x) - c * 16;
        for (let r = r0; r <= r1; r++) {
          if (this.slopes[r + ',' + c] !== ch) continue;
          const sY = this.slopeSurfaceY(ch, r, lx);
          if (y1 > sY + 9 && y0 < sY + 9) return Math.min(16, sY + 9 - y0);   // 밑면에 파고든 깊이(45도라 가로=세로)
        }
        return 0;
      };
      const pr = test('\\', body.right - 0.5);   // ╲ 경사: 오른쪽으로 걸어 들어오면 막힘
      const wallAt = (x) => this.solidAt(x, body.top + 2) || this.solidAt(x, body.bottom - 2) || x < 16 || x > DT.W - 16;
      if (pr > 0) {   // 밀어낼 자리가 벽이면 밀지 않고 멈추기만 함 (벽 속으로 끼어 들어가지 않게)
        if (!wallAt(body.left - pr)) body.x -= pr;
        if (body.velocity.x > 0) body.velocity.x = 0; body.blocked.right = true; return;
      }
      const pl = test('/', body.left + 0.5);       // ╱ 경사: 왼쪽으로 걸어 들어오면 막힘
      if (pl > 0) {
        if (!wallAt(body.right + pl)) body.x += pl;
        if (body.velocity.x < 0) body.velocity.x = 0; body.blocked.left = true;
      }
    }
    applySlopes() {
      if (!this.slopes || !Object.keys(this.slopes).length) { this.onSlope = null; return; }
      const p = this.player;
      this.onSlope = (!this.dead && this.time.now >= this.dropUntil) ? this.stickToSlope(p.body, !!this.onSlope) : null;
      if (!this.onSlope && !this.dead) this.blockSlopeUnderside(p.body);
      this.enemies.getChildren().forEach(e => {
        if (!e.active || e.state === 'dead' || (e.flyer && e.state === 'active')) { e.onSlope = null; return; }
        if (this.time.now < (e.dropUntil || 0)) { e.onSlope = null; return; }
        e.onSlope = this.stickToSlope(e.body, !!e.onSlope, e.state === 'rolling' || e.state === 'sealed');
        if (!e.onSlope) this.blockSlopeUnderside(e.body);
      });
      [this.frags, this.poops, this.waves].forEach(g => g.getChildren().forEach(o => { if (o.active) { o.onSlope = this.stickToSlope(o.body, !!o.onSlope); if (!o.onSlope) this.blockSlopeUnderside(o.body); } }));
      // 탄은 경사로(대각선 발판)를 뚫지 못함: 띠에 닿으면 터짐 (도토리탄은 위에 올라타면 계속 굴러감)
      // 지난 프레임 위치 → 지금 위치 사이를 촘촘히 검사 (빠른 물방울탄이 한 프레임에 띠를 건너뛰지 않게)
      const crossed = (o) => {
        const x0 = o.px === undefined ? o.x : o.px, y0 = o.py === undefined ? o.y : o.py;
        const n = Math.max(1, Math.ceil(Math.hypot(o.x - x0, o.y - y0) / 3));
        let hit = false;
        for (let i = 1; i <= n && !hit; i++) hit = this.slopeHit(x0 + (o.x - x0) * i / n, y0 + (o.y - y0) * i / n);
        o.px = o.x; o.py = o.y;
        return hit;
      };
      this.seeds.getChildren().slice().forEach(sd => {
        if (!sd.active) return;
        if (sd.mode === 'roll' && this.stickToSlope(sd.body)) { sd.px = sd.x; sd.py = sd.y; return; }
        if (crossed(sd)) { this.fxLeaf.explode(3, sd.x, sd.y); sd.destroy(); }
      });
      this.eshots.getChildren().slice().forEach(sh => { if (sh.active && !sh.isShock && crossed(sh)) this.popShot(sh); });
    }

    addBody(x, y, w, h, oneWay) {
      const z = this.add.zone(x + w / 2, y + h / 2, w, h);
      this.physics.add.existing(z, true);
      if (oneWay) {
        z.oneWay = true;
        z.body.checkCollision.down = false;
        z.body.checkCollision.left = false;
        z.body.checkCollision.right = false;
      }
      this.terrain.push(z);
    }

    buildDropQueue() {
      const chars = [];
      (this.stage.chunks || []).forEach(id => {
        const v = DT.DATA.vocabById[id];
        if (v) v.chars.forEach(ch => chars.push({ h: ch.h, p: ch.p }));
      });
      this.dropQueue = chars;
    }

    /* ───────────── 이펙트 ───────────── */
    createFx() {
      const base = { emitting: false };
      const soften = (em, k) => { const ex = em.explode.bind(em); em.explode = (n, x, y) => ex(Math.max(1, Math.round((n || 1) * k)), x, y); return em; };
      this.softenFx = soften;
      this.fxLeaf = this.add.particles(0, 0, 'leaf', Object.assign({
        speed: { min: 40, max: 120 }, angle: { min: 0, max: 360 }, lifespan: { min: 250, max: 550 },
        gravityY: 300, rotate: { min: 0, max: 360 }, scale: { start: 1, end: 0.3 }
      }, base)).setDepth(30);
      this.fxStar = this.add.particles(0, 0, 'star', Object.assign({
        speed: { min: 60, max: 190 }, angle: { min: 0, max: 360 }, lifespan: { min: 300, max: 700 },
        gravityY: 200, scale: { start: 1, end: 0 }, tint: [0xffcd75, 0xf4f4f4, 0xa7f070, 0x73eff7, 0xef7d57]
      }, base)).setDepth(31);
      this.fxPx = this.add.particles(0, 0, 'px', Object.assign({
        speed: { min: 30, max: 140 }, angle: { min: 0, max: 360 }, lifespan: { min: 200, max: 500 },
        gravityY: 260, scale: { start: 1, end: 0 }, tint: [0xa7f070, 0x38b764, 0xf4f4f4]
      }, base)).setDepth(30);
      this.fxDust = this.add.particles(0, 0, 'px', Object.assign({
        speedX: { min: -40, max: 40 }, speedY: { min: -30, max: -5 }, lifespan: 300,
        scale: { start: 1, end: 0 }, tint: 0x94b0c2, alpha: { start: 0.8, end: 0 }
      }, base)).setDepth(8);
      // 파편 이펙트 개수를 줄여 눈이 덜 어지럽게
      soften(this.fxStar, 0.45); soften(this.fxLeaf, 0.6); soften(this.fxPx, 0.6);
      this.ambientFx = DT.ambient(this, this.theme, -5);
    }

    ring(x, y, tint, scale) {
      const r = this.add.sprite(x, y, 'ring', 0).setTint(tint || 0xffffff).setScale(Math.min(2, (scale || 1) * 0.7)).setDepth(29).setAlpha(0.8);
      r.play('fx_ring');
      r.once('animationcomplete', () => r.destroy());
    }

    popText(x, y, str, tint, scale, life) {
      const t = DT.ptext(this, DT.clamp(x, 20, 300), y, str, { ox: 0.5, oy: 0.5, tint: tint === undefined ? 0xffffff : tint, scale: scale || 1, depth: 45 });
      this.tweens.add({ targets: t, y: y - 16, alpha: { from: 1, to: 0 }, duration: life || 800, ease: 'Cubic.easeIn', onComplete: () => t.destroy() });
      return t;
    }

    comboText(x, y, n, pts) {
      const cx = DT.clamp(x, 44, 276);
      const colors = [0xffcd75, 0xef7d57, 0x73eff7, 0xa7f070];
      if (this.lastCombo) { this.lastCombo.forEach(o => { this.tweens.killTweensOf(o); o.destroy(); }); }
      const t1 = DT.ptext(this, cx, y - 14, 'COMBO ×' + n, { ox: 0.5, oy: 0.5, tint: colors[n % 4], depth: 46 });
      const t2 = DT.ptext(this, cx, y - 4, '+' + pts, { ox: 0.5, oy: 0.5, tint: 0xf4f4f4, depth: 46 });
      t1.setScale(2.4); t2.setScale(0.5);
      this.lastCombo = [t1, t2];
      this.tweens.add({ targets: t1, scale: n >= 3 ? 1.5 : 1, duration: 260, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t2, scale: 1, duration: 260, ease: 'Back.easeOut' });
      this.tweens.add({ targets: [t1, t2], y: '-=14', alpha: 0, delay: 650, duration: 450, onComplete: () => { t1.destroy(); t2.destroy(); if (this.lastCombo && this.lastCombo[0] === t1) this.lastCombo = null; } });
    }

    banner(str, tint, scale, life) {
      const t = DT.ptext(this, 160, 112, str, { ox: 0.5, oy: 0.5, tint: tint || 0xffcd75, scale: 0.5, depth: 60 });
      this.ui.add(t);
      this.tweens.add({ targets: t, scale: scale || 3, duration: 280, ease: 'Back.easeOut' });
      this.tweens.add({ targets: t, alpha: 0, delay: life || 900, duration: 300, onComplete: () => t.destroy() });
      return t;
    }

    hitStop(ms) {
      if (this.hitStopping || this.isPaused) return;
      this.hitStopping = true;
      this.physics.world.pause();
      this.time.delayedCall(ms, () => {
        this.hitStopping = false;
        if (!this.isPaused) this.physics.world.resume();
      });
    }

    /* ───────────── 플레이어 ───────────── */
    createPlayer() {
      const sp = this.playerSpawn || { x: 160, y: 200 };
      const p = this.player = this.physics.add.sprite(sp.x, sp.y, 'hero_' + this.hero, 0);
      p.setScale(DT.SPR);
      p.body.setSize(10, 13).setOffset(3, 3);
      p.body.setMaxVelocity(1000, T.MAX_FALL);
      p.setCollideWorldBounds(true);
      p.setDepth(10);
      p.play(this.hero + '_idle');
    }

    updatePlayer(time) {
      const p = this.player, b = p.body, I = DT.Input;
      if (this.dead) { p.angle += 12; return; }
      if (this.updateCarry(time)) return;
      const onGround = b.blocked.down || b.touching.down || !!this.onSlope;
      if (onGround) this.lastGroundAt = time;
      const locked = this.controlLocked;
      const knock = time < this.knockUntil;

      let target = 0;
      if (!locked) { if (I.isDown('left')) target -= 1; if (I.isDown('right')) target += 1; }
      if (target !== 0) this.facing = target;
      if (!knock) {
        const nv = Phaser.Math.Linear(b.velocity.x, target * this.S.move, onGround ? T.PLAYER_ACCEL : T.PLAYER_AIR_ACCEL);
        b.setVelocityX(target === 0 && Math.abs(nv) < 3 ? 0 : nv);
        // 경사로: 가만히 있어도 아래로 미끄러지고, 내리막으로 달리면 더 빨라짐 · 오르막은 느림
        if (this.onSlope) {
          const d = this.onSlope.down, dt = this.game.loop.delta / 1000;
          if (target === 0) b.setVelocityX(DT.clamp(this.slideVx = (this.slideVx || 0) + d * 300 * dt, -170, 170));
          else if (target === d) b.setVelocityX(target * this.S.move * 1.7);
          else b.setVelocityX(target * this.S.move * 0.7);
          if (Math.abs(b.velocity.x) > 80 && time > (this.slideDustAt || 0)) { this.slideDustAt = time + 70; this.fxDust.explode(2, p.x - d * 4, p.y + 8); }
        } else this.slideVx = 0;
        if (this.onSlope && target === 0) this.slideVx = b.velocity.x;
      }

      // 점프 (코요테 타임 + 입력 버퍼 + 가변 높이)
      if (!locked && I.justDown('jump')) {
        if (I.isDown('down') && onGround && this.onOneWay()) {
          this.dropUntil = time + 260;
          b.setVelocityY(60);
          this.fxDust.explode(3, p.x, p.y + 8);
        } else this.jumpBufferUntil = time + T.JUMP_BUFFER_MS;
      }
      if (!knock && time < this.jumpBufferUntil && time - this.lastGroundAt <= T.COYOTE_MS) {
        b.setVelocityY(-this.S.jump);
        this.jumpBufferUntil = 0; this.lastGroundAt = -1e9; this.jumping = true;
        this.fxDust.explode(4, p.x, p.y + 8);
        DT.Audio.sfx('jump');
      }
      if (this.jumping && !I.isDown('jump') && b.velocity.y < -T.JUMP_CUT) b.setVelocityY(-T.JUMP_CUT);
      if (b.velocity.y >= 0) this.jumping = false;
      let gy = 0;
      if (!onGround) {
        if (Math.abs(b.velocity.y) < 45 && I.isDown('jump')) gy = -T.GRAVITY * 0.45; // 정점에서 살짝 떠 있는 느낌
        else if (b.velocity.y > 0) gy = T.GRAVITY * 0.22;                            // 내려올 땐 조금 빠르게
      }
      b.setGravityY(gy);

      // 착지
      if (onGround && !this.wasOnGround) {
        if (time - this.airStart > 180) { this.fxDust.explode(5, p.x, p.y + 8); DT.Audio.sfx('land'); }
      }
      if (!onGround && this.wasOnGround) this.airStart = time;
      this.wasOnGround = onGround;

      // 구체 밀기: 땅에서 구체 쪽으로 걸어가면 천천히 밀림
      this.pushing = false;
      if (onGround && target !== 0 && !knock) {
        const o = this.findOrb(target, 16, 10);
        if (o) {
          o.pushedAt = time;
          o.body.setVelocityX(target * T.PUSH_SPEED * this.S.pushPow);
          b.setVelocityX(target * T.PUSH_SPEED * this.S.pushPow);
          this.pushing = true;
        }
      }
      // 구체 옆에서 공격 버튼 → 드롭킥 (땅에서든 공중에서든)
      if (!locked && !this.fireLocked && !this.dropkick && I.justDown('fire')) {
        const o = this.findOrb(this.facing, T.STRIKE_REACH + this.S.kickReach, onGround ? 14 : 22);
        if (o) this.strike(o, onGround, time);
      }
      this.updateDropkick(time, onGround);

      // 공격 (누르고 있으면 자동 연사)
      if (!locked && !this.fireLocked && I.isDown('fire') && time >= this.nextFireAt && time > this.strikeUntil) {
        if (this.seeds.countActive(true) < T.MAX_SEEDS * this.S.multishot) {
          this.shoot(time);
          this.nextFireAt = time + this.S.fireInterval * (time < this.powerUntil ? 0.6 : 1);
        }
      }

      // 애니메이션
      p.setFlipX(this.facing < 0);
      let anim;
      if (this.winPose) anim = 'win';
      else if (time < this.hurtUntil) anim = 'hurt';
      else if (this.dropkick) anim = time < this.dk.hitAt ? 'tuck' : 'kick';
      else if (this.pushing) anim = 'push';
      else if (time < this.shootPoseUntil) anim = 'shoot';
      else if (!onGround) anim = b.velocity.y < 0 ? 'jump' : 'fall';
      else if (Math.abs(b.velocity.x) > 12) anim = 'run';
      else anim = 'idle';
      p.play(this.hero + '_' + anim, true);

      p.setAlpha(time < this.invUntil ? (Math.floor(time / 60) % 2 ? 0.3 : 1) : 1);
      if (time < this.powerUntil) {
        p.setTint(Math.floor(time / 80) % 2 ? 0xffffff : 0xffe9a0);
        if (Math.random() < 0.25) this.fxPx.emitParticleAt(p.x + Phaser.Math.Between(-6, 6), p.y + Phaser.Math.Between(-6, 6), 1);
      } else if (p.tintTopLeft !== 0xffffff) p.clearTint();
    }

    // 굴러가는 구체에 쓸리면 같이 데굴데굴 (스노우브로스처럼). 구체가 터지거나 점프하면 빠져나옴
    updateCarry(time) {
      const p = this.player, I = DT.Input;
      if (!this.carried) {
        if (this.controlLocked || this.cleared) return false;
        let o = this.enemies.getChildren().find(e => e.active && e.state === 'rolling' && this.heroDef.orb === 'roll' &&
          time - e.rolledAt > 280 && Math.abs(e.x - p.x) < 12 && Math.abs(e.y - p.y) < 14);
        // 퐁이의 물결에도 휩쓸려 같이 흘러감
        if (!o) o = this.waves.getChildren().find(w => w.active && time - w.bornAt > 280 && Math.abs(w.x - p.x) < 12 && Math.abs(w.y - p.y) < 14);
        if (!o) return false;
        if (time < (this.carryCool || 0)) return false;
        this.carried = o; this.carryAt = time;
        this.popText(p.x, p.y - 18, o.isWave ? '첨벙~' : '으아아~', o.isWave ? 0x73eff7 : 0xa7f070);
        DT.Audio.sfx('bump');
      }
      const o = this.carried;
      const release = (jump) => {
        this.carried = null; this.carryCool = time + 400;
        p.setAngle(0);
        p.body.setAllowGravity(true);
        p.body.setVelocity((o.rollDir || this.facing) * 60, jump ? -this.S.jump * 0.9 : -180);
        this.invUntil = Math.max(this.invUntil, time + 500);
        this.fxDust.explode(4, p.x, p.y + 8);
      };
      if (!o.active || (!o.isWave && o.state !== 'rolling')) { release(false); return false; }
      if (I.justDown('jump') && time - this.carryAt > 150) { release(true); DT.Audio.sfx('jump'); return false; }
      p.body.reset(o.x, o.y - (o.isWave ? 8 : 3));
      p.body.setAllowGravity(false);
      p.setAngle(o.isWave ? Math.sin(time / 90) * 20 : p.angle + o.rollDir * 18);
      this.facing = o.rollDir;
      this.invUntil = Math.max(this.invUntil, time + 120);
      p.setAlpha(1);
      p.play(this.hero + '_hurt', true);
      return true;
    }

    // 발밑이 일방향 발판(=·무너지는·움직이는)인지
    onOneWay() {
      if (this.onSlope) return true;
      const p = this.player, y = p.body.bottom + 1;
      const hits = this.physics.overlapRect(p.body.x + 1, y, p.body.width - 2, 3, true, true);
      if (!hits.length) return false;
      return hits.every(bd => bd.gameObject && (bd.gameObject.oneWay || bd.gameObject.crumble || bd.gameObject.isMover));
    }

    // 플레이어 앞(dir 방향)에 있는 봉인 구체 찾기
    findOrb(dir, reach, dyMax) {
      const p = this.player;
      let best = null, bd = 1e9;
      this.enemies.getChildren().forEach(e => {
        if (!e.active || e.state !== 'sealed') return;
        const dx = (e.x - p.x) * dir, dy = Math.abs(e.y - p.y);
        if (dx > -4 && dx < reach && dy < dyMax && dx < bd) { best = e; bd = dx; }
      });
      return best;
    }

    // 드롭킥: ① 웅크리며 살짝 뛰어오름(0.09초) → ② 몸을 뒤로 젖히고 두 발을 쭉 뻗어 구체를 '뻥'
    strike(e, onGround, time) {
      const p = this.player;
      this.dropkick = true;
      this.dk = { target: e, dir: this.facing, hitAt: time + 90, done: false, ghostAt: 0 };
      this.strikeUntil = time + 420;
      this.knockUntil = time + 200;           // 뛰어드는 동안은 입력으로 속도가 덮이지 않게
      p.body.setVelocity(this.facing * 120, onGround ? -150 : -70);
      this.nextFireAt = time + 450;
      DT.Audio.sfx('jump');
    }

    updateDropkick(time, onGround) {
      const p = this.player, d = this.dk;
      if (!this.dropkick) { if (p.angle) p.setAngle(0); return; }
      if (!d.done && time >= d.hitAt) {
        d.done = true;
        const e = d.target;
        if (e && e.active && e.state === 'sealed' && Math.abs(e.x - p.x) < 44 && Math.abs(e.y - p.y) < 30) {
          const hx = e.x - d.dir * 9, hy = e.y + 2;   // 불꽃은 구체 쪽에 — 캐릭터 발차기 자세가 가려지지 않게
          const sp = this.add.sprite(hx, hy, 'spark', 0).setDepth(35).setScale(2);
          sp.play('fx_spark'); sp.once('animationcomplete', () => sp.destroy());
          this.fxStar.explode(6, hx, hy);
          this.popText(hx, hy - 14, 'DROP KICK!', 0xffcd75);
          this.launchOrb(e, d.dir);
          p.body.setVelocityX(-d.dir * 40);   // 차고 나서 살짝 튕겨 나옴
        }
      }
      // 몸을 뒤로 젖힌 각도: 웅크릴 땐 살짝, 찰 땐 크게
      p.setAngle((time < d.hitAt ? 10 : -40) * d.dir);
      if (d.done && time > d.ghostAt) {     // 잔상
        d.ghostAt = time + 45;
        const g = this.add.image(p.x, p.y, p.texture.key, p.frame.name).setScale(DT.SPR).setFlipX(p.flipX)
          .setAngle(p.angle).setAlpha(0.45).setTint(0xffe9a0).setDepth(9);
        this.tweens.add({ targets: g, alpha: 0, duration: 180, onComplete: () => g.destroy() });
      }
      if (time > this.strikeUntil || (d.done && onGround && time > d.hitAt + 120)) {
        this.dropkick = false; this.dk = null; p.setAngle(0);
      }
    }

    shoot(time) {
      const p = this.player, dir = this.facing, power = time < this.powerUntil;
      const sx = p.x + dir * 8, sy = p.y + 3;
      // 벽에 붙어서 쏘면 탄이 벽 속(또는 벽 너머)에서 생겨 뚫고 나가던 문제: 벽 앞에서 바로 막힘
      if (this.wallBetween(p.x, sx + dir * 4, sy)) {
        this.fxLeaf.explode(3, p.x + dir * 6, sy); this.shootPoseUntil = time + 110;
        DT.Audio.sfx('tick'); return;
      }
      const n = this.S.multishot;
      const vys = n === 1 ? [T.SEED_VY] : n === 2 ? [T.SEED_VY, T.SEED_VY - 85] : [T.SEED_VY + 30, T.SEED_VY - 50, T.SEED_VY - 130];
      const mode = this.heroDef.shot;
      vys.forEach((vy, i) => {
        const s = this.seeds.create(sx, sy, 'seed_' + this.hero);
        s.setDepth(9);
        const big = this.S.shotSize || 1;
        s.setScale(DT.SPR * (power ? 1.4 : 1) * big);
        s.body.setSize(8, 8);
        s.isSeed = true; s.mode = mode; s.dir = dir; s.bornAt = time; s.startX = sx; s.dmg = this.S.dmg + (power ? 1 : 0);
        s.pierceLeft = this.S.pierce || 0; s.hitSet = [];
        s.px = p.x; s.py = sy;   // 경사로 검사는 캐릭터 몸에서부터 (바로 앞 경사로를 넘어 생기지 않게)
        if (mode === 'line') {
          // 물방울: 중력 없이 일직선. 여러 발이면 위아래로 살짝 퍼짐
          s.body.setAllowGravity(false);
          s.speed = this.S.seedVx * 1.5;
          s.range = this.S.seedVx * 0.62;
          s.body.setVelocity(dir * s.speed, n === 1 ? 0 : (i - (n - 1) / 2) * 40);
          s.setScale(DT.SPR * 1.25 * (power ? 1.4 : 1) * big, DT.SPR * 0.85 * (power ? 1.4 : 1) * big);
        } else if (mode === 'roll') {
          // 도토리: 살짝 떴다가 바닥을 따라 굴러감 (발판 끝에서는 아래로 떨어져 계속 굴러감)
          s.body.setAllowGravity(true);
          s.speed = this.S.seedVx * 0.95 * (1 - i * 0.12);
          s.range = this.S.seedVx * 0.85;
          s.body.setVelocity(dir * s.speed, -70 - i * 40);
          s.body.setBounce(0, 0.25);
          s.body.setAngularVelocity(dir * 900);
        } else {
          s.body.setAllowGravity(true);
          s.body.setGravityY(T.SEED_GRAVITY - T.GRAVITY);
          s.body.setVelocity(dir * this.S.seedVx * (1 - i * 0.06) + p.body.velocity.x * 0.2, vy);
          s.body.setAngularVelocity(dir * 720);
        }
      });

      const sp = this.add.sprite(sx + dir * 3, sy, 'spark', 0).setDepth(11);
      sp.play('fx_spark'); sp.once('animationcomplete', () => sp.destroy());
      this.fxLeaf.explode(power ? 4 : 2, sx, sy);
      this.shootPoseUntil = time + 110;
      DT.Audio.sfx('shoot', this.heroDef.shot);
    }

    popSeed(s) {
      if (!s || !s.isSeed || !s.active) return;
      // 도토리는 바닥에 닿아도 계속 굴러가고, 벽에 부딪혀야 터짐
      if (s.mode === 'roll' && !(s.body.blocked.left || s.body.blocked.right)) return;
      this.fxLeaf.explode(3, s.x, s.y);
      s.destroy();
    }

    /* ───────────── 몬스터 ───────────── */
    /* ───────────── 진담 점프: 아래에서 올라오는 가시덩굴/독초를 피해 꼭대기로 ───────────── */
    setupClimb() {
      const c = this.climb, cam = this.cameras.main;
      cam.setBounds(0, 0, DT.W, this.mapH);
      cam.startFollow(this.player, true, 1, 0.12, 0, 30);
      cam.on('followupdate', () => this.syncScreenLayer());
      this.timeLeft = c.time * 1000;
      this.hazardY = this.mapH + 10;
      this.hazard = this.add.tileSprite(0, this.hazardY, DT.W, 40, 'hazard_' + c.hazard).setOrigin(0, 0).setDepth(30);
      this.hazardBody = this.add.rectangle(0, this.hazardY + 39, DT.W, this.mapH + 80, c.hazard === 'thorn' ? 0x2f5a2a : 0x4a2560).setOrigin(0, 0).setDepth(30);
      this.hazardGlow = this.add.rectangle(0, this.hazardY - 4, DT.W, 4, c.hazard === 'thorn' ? 0xb13e53 : 0xb55088, 0.35).setOrigin(0).setDepth(29);
      // 골 깃발
      if (this.goal) {
        this.flag = this.add.image(this.goal.x, this.goal.y, 'goalflag').setOrigin(0.15, 1).setDepth(5);
        this.tweens.add({ targets: this.flag, scaleX: 0.92, yoyo: true, repeat: -1, duration: 300 });
      }
      // 무너지는 발판
      if (this.crumbles) {
        this.physics.add.collider(this.player, this.crumbles, (a, b) => {
          const t = a === this.player ? b : a;
          if (!t.falling && this.player.body.touching.down) this.startCrumble(t);
        }, () => this.time.now >= this.dropUntil);
        this.physics.add.collider(this.enemies, this.crumbles, null, (e) => e.state !== 'dead');
      }
      // 움직이는 발판 (좌우 왕복, 위에 서면 함께 이동)
      this.moverSprites = (this.movers || []).map((m, i) => {
        const sp = this.physics.add.image(m.x, m.y, 'mplat_' + this.theme).setDepth(-1);
        sp.body.setAllowGravity(false); sp.body.setImmovable(true); sp.isMover = true;
        sp.body.checkCollision.down = sp.body.checkCollision.left = sp.body.checkCollision.right = false;
        sp.speed = 34 + (i % 3) * 8; sp.dir = i % 2 ? -1 : 1;
        sp.body.setVelocityX(sp.speed * sp.dir);
        return sp;
      });
      if (this.moverSprites.length) {
        this.physics.add.collider(this.player, this.moverSprites, (a, b) => { this.riding = a === this.player ? b : a; }, () => this.time.now >= this.dropUntil);
        this.physics.add.collider(this.enemies, this.moverSprites, null, (e) => e.state !== 'dead');
        this.physics.add.collider(this.frags, this.moverSprites);
      }
      // 가시 장애물: 닿으면 피해 + 튕겨 오름
      if (this.spikes) this.physics.add.overlap(this.player, this.spikes, () => {
        if (this.dead || this.cleared || this.time.now < this.invUntil) return;
        this.hurtPlayer({ x: this.player.x, y: this.player.y + 10 });
        this.player.body.setVelocity(-this.facing * 90, -300);
        this.popText(this.player.x, this.player.y - 14, '따끔!', 0xb13e53);
      });
      // 문제 관문: 지나가면 퀴즈 (게임 멈춤 · 가시도 멈춤). 틀리면 가시가 점점 더 빨라짐
      (c.gates || []).forEach(r => {
        const y = r * 16;
        const line = this.add.graphics().setDepth(3);
        for (let x = 16; x < 304; x += 8) { line.fillStyle(x % 16 ? 0xffcd75 : 0xef7d57, 0.9); line.fillRect(x, y, 5, 2); }
        const tag = DT.text(this, 160, y - 7, '? 문제 관문 ?', { font: 'ko', size: 8, color: '#ffcd75', strokeThickness: 2, depth: 3 });
        this.tweens.add({ targets: tag, alpha: 0.45, yoyo: true, repeat: -1, duration: 500 });
        this.gates.push({ y, done: false, line, tag });
      });
      // HUD: 남은 시간 · 높이
      this.hudTime = DT.ptext(this, 172, 1, 'TIME 00', { tint: 0xffcd75, depth: 41 });
      this.hudHeight = this.add.graphics().setDepth(41);
      this.ui.add([this.hudTime, this.hudHeight]);
      this.hazardName = c.hazard === 'thorn' ? '가시덩굴' : '독초';
      this.syncScreenLayer();
    }

    /* ── 진담 점프 문제 관문 퀴즈 ── */
    climbQuestion() {
      const D = DT.DATA;
      const ids = Array.from(new Set([].concat(...D.stages.filter(s => s.world === this.stage.world).map(s => s.chunks))));
      const pool = ids.map(id => D.vocabById[id]).filter(Boolean);
      const v = pool[Math.floor(Math.random() * pool.length)];
      const others = DT.shuffle(pool.filter(x => x.id !== v.id));
      if (Math.random() < 0.5) {
        return { prompt: '‘' + v.meaning + '’ 는 중국어로?', options: DT.shuffle([v.hanzi, others[0].hanzi, others[1].hanzi]), answer: v.hanzi, v };
      }
      return { prompt: v.hanzi + '  (' + v.pinyin + ')  의 뜻은?', options: DT.shuffle([v.meaning, others[0].meaning, others[1].meaning]), answer: v.meaning, v };
    }

    openClimbQuiz(gate) {
      const q = this.climbQuestion();
      this.physics.world.pause();
      gate.line.setAlpha(0.3); gate.tag.setText('통과!');
      DT.Audio.sfx('warn');
      const box = DT.panel(this, 10, 150, 300, 82, { border: DT.C.yellow, fill: DT.C.ink, alpha: 0.95 });
      const title = DT.ptext(this, 18, 156, 'QUIZ GATE', { tint: 0xffcd75 });
      const pr = DT.text(this, 160, 172, q.prompt, { font: q.answer === q.v.hanzi ? 'ko' : 'zh', size: 12, color: '#ffffff', strokeThickness: 2 });
      const opts = q.options.map((o, i) => {
        const x = 62 + i * 98, y = 200;
        const bg = this.add.rectangle(x, y, 90, 22, 0x29366f, 1).setStrokeStyle(1, 0x94b0c2);
        const t = DT.text(this, x, y, o, { font: q.answer === q.v.hanzi ? 'zh' : 'ko', size: o.length > 5 ? 9 : 12, color: '#ffffff', stroke: null });
        return { bg, t, value: o };
      });
      const bar = this.add.rectangle(18, 222, 284, 4, 0xa7f070).setOrigin(0, 0.5);
      const hint = DT.text(this, 160, 228, '← → 고르기 · 공격(Z) 결정 · 틀리면 ' + this.hazardName + '이(가) 빨라져요', { font: 'ko', size: 7, color: '#94b0c2', stroke: null });
      this.ui.add([box, title, pr, bar, hint].concat(...opts.map(o => [o.bg, o.t])));
      this.climbQuiz = { q, opts, sel: 1, until: this.time.now + 9000, parts: [box, title, pr, bar, hint].concat(...opts.map(o => [o.bg, o.t])), bar };
      opts.forEach((o, i) => o.bg.setInteractive({ useHandCursor: true }).on('pointerdown', () => { if (this.climbQuiz) { this.climbQuiz.sel = i; this.answerClimbQuiz(); } }));
      this.refreshClimbQuiz();
    }
    refreshClimbQuiz() {
      const Q = this.climbQuiz;
      Q.opts.forEach((o, i) => { o.bg.setFillStyle(i === Q.sel ? 0x3b5dc9 : 0x29366f, 1).setStrokeStyle(i === Q.sel ? 2 : 1, i === Q.sel ? 0xffcd75 : 0x94b0c2); });
    }
    updateClimbQuiz(time) {
      const Q = this.climbQuiz, I = DT.Input;
      const left = Q.until - time;
      Q.bar.width = Math.max(0, 284 * left / 9000);
      Q.bar.setFillStyle(left < 3000 ? 0xb13e53 : 0xa7f070);
      if (I.justDown('left')) { Q.sel = (Q.sel + 2) % 3; DT.Audio.sfx('select'); this.refreshClimbQuiz(); }
      if (I.justDown('right')) { Q.sel = (Q.sel + 1) % 3; DT.Audio.sfx('select'); this.refreshClimbQuiz(); }
      if (I.justDown('fire') || I.justDown('confirm')) this.answerClimbQuiz();
      else if (left <= 0) this.answerClimbQuiz(true);
    }
    answerClimbQuiz(timeout) {
      const Q = this.climbQuiz;
      if (!Q || Q.answered) return;
      Q.answered = true;
      const ok = !timeout && Q.opts[Q.sel].value === Q.q.answer;
      Q.opts.forEach(o => { if (o.value === Q.q.answer) o.bg.setFillStyle(0x38b764, 1); });
      if (ok) {
        DT.Audio.sfx('right');
        DT.Audio.speak(Q.q.v.hanzi);
        this.addScore(800);
        this.timeLeft += 5000;
        this.hazardY = Math.min(this.mapH + 10, this.hazardY + 48);
        this.hazardMul = Math.max(1, this.hazardMul - 0.1);
        this.banner('정답! +5초', 0xa7f070, 1.6, 700);
      } else {
        if (!timeout) Q.opts[Q.sel].bg.setFillStyle(0xb13e53, 1);
        DT.Audio.sfx('wrong');
        this.hazardMul += 0.35;
        this.banner(timeout ? '시간 초과!' : '아쉬워요!', 0xb13e53, 1.6, 700);
        this.hintText(this.hazardName + '이(가) 더 빨라졌어요! 정답: ' + Q.q.answer);
      }
      this.time.delayedCall(ok ? 900 : 1500, () => {
        Q.parts.forEach(o => o.destroy());
        this.climbQuiz = null;
        if (!this.isPaused) this.physics.world.resume();
      });
    }

    startCrumble(t) {
      t.falling = true;
      this.tweens.add({ targets: t, x: t.home.x + 1, yoyo: true, repeat: 5, duration: 40, onComplete: () => {
        t.body.enable = false;
        this.tweens.add({ targets: t, y: t.home.y + 20, alpha: 0, duration: 260 });
        this.fxDust.explode(5, t.x, t.y);
        DT.Audio.sfx('crumble');
        this.time.delayedCall(3200, () => {
          if (!t.active) return;
          t.setPosition(t.home.x, t.home.y).setAlpha(0); t.body.enable = true; t.body.reset(t.home.x, t.home.y); t.falling = false;
          this.tweens.add({ targets: t, alpha: 1, duration: 300 });
        });
      } });
    }

    // 화면 고정 레이어(HUD·배경)를 카메라 위치에 맞춤
    syncScreenLayer() {
      const v = this.cameras.main.worldView;
      this.ui.setPosition(v.x, v.y);
      this.bg.setPosition(v.x, v.y);
      if (this.ambientFx) this.ambientFx.setPosition(v.x, v.y);
    }

    updateClimb(time, delta) {
      const c = this.climb, p = this.player;
      // 움직이는 발판 왕복 + 올라탄 플레이어 이동
      (this.moverSprites || []).forEach(sp => {
        if (sp.x < 32) sp.dir = 1; else if (sp.x > 288) sp.dir = -1;
        sp.body.setVelocityX(sp.speed * sp.dir);
      });
      // (올라탄 캐릭터는 물리엔진의 마찰로 이미 함께 움직임 — 여기서 또 더하면 반대로 걸을 때 제자리에 멈춰 버림)
      this.riding = null;
      if (!this.started || this.cleared || this.dead) return;
      // 제한 시간
      // 문제 관문 통과 → 퀴즈
      for (const gt of this.gates) {
        if (!gt.done && p.y < gt.y) { gt.done = true; this.openClimbQuiz(gt); return; }
      }
      this.timeLeft -= delta;
      const sec = Math.max(0, Math.ceil(this.timeLeft / 1000));
      if (sec !== this.lastSec) {
        this.lastSec = sec;
        this.hudTime.setText('TIME ' + DT.pad(sec, 2)).setTint(sec <= 10 ? 0xb13e53 : 0xffcd75);
        if (sec <= 10 && sec > 0) DT.Audio.sfx('tick');
        if (sec === 0) { this.banner('TIME UP!', 0xb13e53, 2.5, 1000); this.hintText(this.hazardName + '이(가) 빨라져요! 서둘러요!'); }
      }
      // 올라오는 위험 지대: 점점 빨라지고, 너무 뒤처지면 화면 아래까지 따라옴
      const elapsed = (time - this.stageStartAt) / 1000;
      let speed = elapsed < 2.5 ? 0 : (c.speed + elapsed * (c.accel || 0.18)) * this.hazardMul * (this.S.hazardSlow || 1);
      if (this.timeLeft <= 0) speed *= 4;
      this.hazardY -= speed * delta / 1000;
      const viewBottom = this.cameras.main.worldView.bottom;
      if (this.hazardY > viewBottom + 14) this.hazardY = viewBottom + 14;
      this.hazard.setY(this.hazardY);
      this.hazardBody.setY(this.hazardY + 39);
      this.hazard.tilePositionX = Math.sin(time / 500) * 6;
      this.hazardGlow.setY(this.hazardY - 4).setAlpha(0.25 + Math.sin(time / 120) * 0.12);
      if (Math.random() < 0.3) this.fxPx.emitParticleAt(Math.random() * 320, this.hazardY + 2, 1);
      // 닿으면 피해 + 위로 튕겨 올림
      if (p.body.bottom > this.hazardY + 5 && time >= this.invUntil) {
        this.hurtPlayer({ x: p.x, y: p.y + 20 });
        p.body.setVelocity(0, -420);
        this.popText(p.x, p.y - 14, 'OUCH!', 0xb13e53);
      }
      // 몬스터·조각도 삼킴
      this.enemies.getChildren().forEach(e => { if (e.active && e.state !== 'dead' && e.y > this.hazardY + 4) this.killEnemy(e, 1); });
      this.frags.getChildren().slice().forEach(f => { if (f.active && f.y > this.hazardY) { if (f.label) f.label.destroy(); f.destroy(); } });
      // 높이 게이지
      const g = this.hudHeight; g.clear();
      const top = this.goal ? this.goal.y : 48, prog = DT.clamp((this.mapH - p.y) / (this.mapH - top), 0, 1);
      const hz = DT.clamp((this.mapH - this.hazardY) / (this.mapH - top), 0, 1);
      g.fillStyle(DT.C.ink, 0.8); g.fillRect(310, 24, 6, 170);
      g.fillStyle(0xb13e53, 0.9); g.fillRect(311, 25 + 168 * (1 - hz), 4, 168 * hz);
      g.fillStyle(0xa7f070, 1); g.fillRect(309, 24 + 168 * (1 - prog), 8, 3);
      g.fillStyle(0xffcd75, 1); g.fillRect(309, 22, 8, 3);
      // 골인
      if (this.goal && p.y < this.goal.y) this.climbClear();
    }

    climbClear() {
      if (this.cleared) return;
      const bonus = Math.max(0, Math.ceil(this.timeLeft / 1000)) * 100;
      this.banner('GOAL!', 0xa7f070, 3, 1400);
      if (bonus) { this.popText(this.player.x, this.player.y - 20, 'TIME BONUS +' + bonus, 0xffcd75, 1, 1500); this.addScore(bonus); }
      this.addScore(5000);
      DT.Audio.sfx('perfect');
      this.enemies.getChildren().slice().forEach(e => { if (e.state !== 'dead') this.killEnemy(e, e.x < 160 ? -1 : 1); });
      this.stageClear();
    }

    /* ───────────── 보스: 작은 적을 봉인한 구체로만 공격 가능 ───────────── */
    createBoss(def) {
      const style = def.style || 'ground';
      const START = { ground: [250, 198], fly: [250, 70], ceil: [250, 55], warp: [250, 150] }[style];
      const b = this.boss = this.physics.add.sprite(START[0], START[1], def.kind, 0);
      b.style = style; b.mode = style === 'ground' ? null : (style === 'fly' ? 'hover' : style === 'ceil' ? 'crawl' : 'idle');
      b.setScale(3.2).setTint(def.tint || 0xffffff).setDepth(5).setFlipX(true);
      if (style !== 'ground') b.body.setAllowGravity(false);
      if (style === 'ceil') { b.setFlipY(true); b.ceilY = START[1]; }
      if (style === 'warp') { b.anchors = this.bossAnchors(); b.modeAt = this.time.now + 1500; const a0 = b.anchors[b.anchors.length - 1]; b.setPosition(a0.x, a0.y); b.homeY = a0.y; }
      b.body.setSize(12, 14).setOffset(2, 2);
      b.setCollideWorldBounds(true);
      b.def = def; b.hp = b.maxHp = def.hp; b.dir = -1; b.state = 'spawn';
      b.nextAttack = 0; b.nextSpawn = 0; b.invUntil = 0; b.attack = null; b.airborne = false;
      b.play(def.kind + '_walk');
      b.crown = this.add.image(b.x, b.y - 30, 'crown').setDepth(6).setScale(1.4);
      this.physics.add.collider(b, this.terrain, null, (a, c) => {
        const z = a === b ? c : a;
        if (b.state === 'dead') return false;
        if (b.style === 'warp') return false;
        if (b.style === 'fly') return b.mode === 'dive' || b.mode === 'land';
        if (b.style === 'ceil') return b.mode !== 'climb' && b.mode !== 'crawl' && !(z.oneWay && b.mode === 'fall');
        return true;
      });
      this.physics.add.overlap(this.player, b, () => {
        if (b.state === 'active' && !b.ghost && !this.dead && !this.cleared && this.time.now >= this.invUntil) this.hurtPlayer(b);
      });
      this.physics.add.overlap(this.seeds, b, (a, c) => {
        const sd = a.isSeed ? a : c;
        if (!sd.active || b.state === 'dead') return;
        this.fxPx.explode(4, sd.x, sd.y); sd.destroy();
        DT.Audio.sfx('tick');
        if (!this.bossHintAt || this.time.now - this.bossHintAt > 6000) { this.bossHintAt = this.time.now; this.popText(b.x, b.y - 34, 'NO DAMAGE', 0x94b0c2); this.hintText('보스는 작은 적을 봉인한 구체로만 공격할 수 있어요!'); }
      });
      this.physics.add.overlap(this.enemies, b, (a, c) => {
        const e = a === b ? c : a;
        if (e.state === 'rolling' && !b.ghost) { this.bossHit(e); this.burstOrb(e); }
      });
      this.physics.add.overlap(this.waves, b, (a, c) => {
        const w = a === b ? c : a;
        if (w.isWave && !w.hitBoss && !b.ghost) { w.hitBoss = true; this.bossHit(w, 0.5); }   // 물결은 두 갈래라 하나에 0.5 (둘 다 맞아야 다른 주인공의 한 방과 같음)
      });
      // HUD: 보스 이름과 체력
      this.bossName = DT.text(this, 160, 25, def.name, { font: 'ko', size: 9, color: '#ffcd75', strokeThickness: 3, depth: 42 });
      this.bossBar = this.add.graphics().setDepth(42);
      this.ui.add([this.bossName, this.bossBar]);
      this.drawBossBar();
    }

    drawBossBar() {
      const g = this.bossBar, b = this.boss; g.clear();
      g.fillStyle(DT.C.ink, 1); g.fillRect(99, 31, 122, 6);
      g.fillStyle(0x566c86, 1); g.fillRect(100, 32, 120, 4);
      g.fillStyle(b.hp > b.maxHp / 2 ? 0xef7d57 : 0xb13e53, 1); g.fillRect(100, 32, Math.round(120 * Math.max(0, b.hp) / b.maxHp), 4);
      g.fillStyle(0xffffff, 0.35); g.fillRect(100, 32, Math.round(120 * Math.max(0, b.hp) / b.maxHp), 1);
    }

    updateBoss(time) {
      const b = this.boss;
      if (!b || !b.active) return;
      b.crown.setPosition(Math.round(b.x), Math.round(b.y + (b.flipY ? 28 : -28))).setFlipY(b.flipY).setAlpha(b.alpha);
      if (b.state !== 'active') return;
      const body = b.body, onGround = body.blocked.down || body.touching.down;
      const rage = b.hp <= b.maxHp / 2;
      if (time < b.invUntil) b.setTintFill(Math.floor(time / 60) % 2 ? 0xffffff : 0xff6070);
      else if ((b.attack && b.attack.warn && time < b.attack.at) || (b.warnUntil && time < b.warnUntil)) b.setTint(Math.floor(time / 80) % 2 ? 0xffffff : (b.def.tint || 0xffffff));
      else b.setTint(b.def.tint || 0xffffff);
      if (b.style !== 'ground') {
        if (b.style === 'fly') this.updateBossFly(b, time, rage);
        else if (b.style === 'ceil') this.updateBossCeil(b, time, rage);
        else this.updateBossWarp(b, time, rage);
        this.bossMinions(b, time, rage);
        return;
      }

      // 착지 충격파
      if (b.airborne && onGround && body.velocity.y >= 0) {
        b.airborne = false;
        this.cameras.main.shake(140, 0.008);
        DT.Audio.sfx('bump');
        if (b.shockOnLand) {
          [-1, 1].forEach(d => { const sh = this.fireShot('shock', b.x + d * 22, body.bottom - 5, d * 150, 0, { anim: 'shock_go', solidOnly: true, unbreakable: true, life: 2200 }); sh.isShock = true; });
          b.shockOnLand = false;
        }
      }
      if (!onGround) b.airborne = true;

      // 진행 중인 공격
      const A = b.attack;
      if (A) {
        if (A.type === 'charge') {
          if (time < A.at) body.setVelocityX(0);
          else {
            body.setVelocityX(A.dir * 270);
            if (time > A.at + 100 && (body.blocked.left || body.blocked.right)) {
              this.cameras.main.shake(200, 0.01); DT.Audio.sfx('bump');
              body.setVelocity(-A.dir * 80, -160); b.attack = null; b.nextAttack = time + 1100;
            } else if (time > A.at + 2400) b.attack = null;
          }
        } else if (time >= A.at && !A.fired) {
          A.fired = true;
          this.bossFire(A, rage);
          b.attack = null;
          b.nextAttack = time + Phaser.Math.Between(1700, 2600) * (rage ? 0.65 : 1);
        } else if (time < A.at) body.setVelocityX(0);
        b.setFlipX((A.dir || b.dir) < 0);
      } else {
        // 걷기 + 다음 공격 고르기
        if (body.blocked.left) b.dir = 1; else if (body.blocked.right) b.dir = -1;
        const spd = (b.def.kind === 'thief' ? 50 : 30) * (rage ? 1.5 : 1);
        if (onGround) body.setVelocityX(b.dir * spd);
        b.setFlipX(b.dir < 0);
        if (onGround && time > b.nextAttack) this.bossChoose(time, rage);
      }

      this.bossMinions(b, time, rage);
    }
    // 졸개는 계속 조금씩 나옴 (구체 재료)
    bossMinions(b, time, rage) {
      const minions = this.enemies.getChildren().filter(e => e.state !== 'dead').length;
      if (time > b.nextSpawn && minions < 3) { b.nextSpawn = time + (rage ? 3200 : 4400); this.bossSummon(1); }
    }
    // 다음 기술 고르기 (같은 기술이 연달아 나오지 않게)
    bossPick(b, moves) {
      let m = moves[Math.floor(Math.random() * moves.length)];
      if (m === b.lastMove) m = moves[(moves.indexOf(m) + 1) % moves.length];
      b.lastMove = m; return m;
    }
    bossWarn(b, ms) { b.warnUntil = this.time.now + ms; this.emote(b, '!'); DT.Audio.sfx('warn'); }
    aimShot(key, x, y, sp, opt) {
      const p = this.player, a = Math.atan2(p.y - y, p.x - x);
      return this.fireShot(key, x, y, Math.cos(a) * sp, Math.sin(a) * sp, opt);
    }

    /* ── 2월드: 날아다니는 보스 (구름 성조새 대왕) — 하늘을 빙빙, 급강하 뒤 부리가 땅에 박혀 잠깐 꼼짝 못 함 ── */
    updateBossFly(b, time, rage) {
      const body = b.body, p = this.player, spd = rage ? 75 : 55;
      b.play(b.def.kind + '_walk', true);
      if (b.mode === 'hover') {
        if (b.x < 60) b.dir = 1; else if (b.x > 260) b.dir = -1;
        const ty = 62 + Math.sin(time / 600) * 16;
        body.setVelocity(b.dir * spd, (ty - b.y) * 3);
        b.setFlipX(b.dir < 0);
        if (time > b.nextAttack) {
          const m = this.bossPick(b, ['dive', 'feathers', 'gust', 'dive', 'land', 'summon']);
          b.nextAttack = time + Phaser.Math.Between(2000, 2800) * (rage ? 0.65 : 1);
          if (m === 'dive') { this.bossWarn(b, 650); b.mode = 'aim'; b.modeAt = time + 650; }
          else if (m === 'land') { b.mode = 'land'; b.modeAt = time + 4000; this.emote(b, '?'); }
          else if (m === 'feathers') {
            const n = rage ? 7 : 5;
            for (let i = 0; i < n; i++) this.time.delayedCall(i * 160, () => {
              if (b.state !== 'active') return;
              this.fireShot('spore', DT.clamp(p.x + (i - (n - 1) / 2) * 26, 24, 296), b.y + 18, 0, 95, { tint: 0xb8e6ff, life: 3200 });
              DT.Audio.sfx('throw');
            });
          } else if (m === 'gust') {
            [-12, 0, 12].forEach((dy, i) => this.time.delayedCall(i * 180, () => b.state === 'active' && this.aimShot('spore', b.x, b.y + dy, 120, { tint: 0x73eff7, life: 3000 })));
            DT.Audio.sfx('fire');
          } else this.bossSummon(rage ? 3 : 2);
        }
      } else if (b.mode === 'aim') {
        body.setVelocity(0, 0);
        if (time > b.modeAt) {
          const a = Math.atan2(p.y - b.y, p.x - b.x);
          body.setVelocity(Math.cos(a) * 250, Math.max(120, Math.sin(a) * 250));
          b.setFlipX(Math.cos(a) < 0); b.mode = 'dive'; b.modeAt = time + 1300;
          DT.Audio.sfx('jump');
        }
      } else if (b.mode === 'dive') {
        if (body.blocked.down || body.touching.down || time > b.modeAt || b.y > 200) {
          body.setVelocity(0, 0); b.mode = 'stuck'; b.modeAt = time + 1500;
          this.cameras.main.shake(140, 0.008); DT.Audio.sfx('bump');
          this.fxDust.explode(10, b.x, b.y + 20);
          this.popText(b.x, b.y - 30, '부리가 쿡!', 0xffcd75);
        }
      } else if (b.mode === 'land') {
        // 지쳐서 바닥에 내려앉아 헥헥 (기회!)
        body.setVelocityX(0);
        if (!body.blocked.down && !body.touching.down) body.setVelocityY(110);
        else { body.setVelocityY(0); if (!b.landed) { b.landed = true; this.popText(b.x, b.y - 30, '헥헥…', 0x94b0c2); } }
        if (time > b.modeAt) { b.landed = false; b.mode = 'rise'; }
      } else if (b.mode === 'stuck') {
        body.setVelocity(0, 0);
        b.angle = Math.sin(time / 40) * 4;
        if (time > b.modeAt) { b.angle = 0; b.mode = 'rise'; }
      } else if (b.mode === 'rise') {
        body.setVelocity(0, -110);
        if (b.y < 70) { b.mode = 'hover'; b.nextAttack = Math.max(b.nextAttack, time + 900); }
      }
    }

    /* ── 3월드: 천장에 붙는 보스 (천장 대왕달팽이) — 천장을 기어 다니며 끈적이를 떨어뜨리고, 쿵! 떨어지면 어지러워함 ── */
    updateBossCeil(b, time, rage) {
      const body = b.body, p = this.player;
      if (b.mode === 'crawl') {
        b.play(b.def.kind + '_walk', true);
        if (b.x < 50) b.dir = 1; else if (b.x > 270) b.dir = -1;
        body.reset(b.x + b.dir * (rage ? 55 : 38) * this.game.loop.delta / 1000, b.ceilY);
        b.setFlipX(b.dir < 0); b.setFlipY(true);
        if (time > b.nextAttack) {
          const m = this.bossPick(b, ['drip', 'drop', 'spit', 'drip', 'drop', 'summon']);
          b.nextAttack = time + Phaser.Math.Between(1900, 2700) * (rage ? 0.65 : 1);
          if (m === 'drop') { this.bossWarn(b, 700); b.mode = 'shake'; b.modeAt = time + 700; }
          else if (m === 'drip') {
            this.bossWarn(b, 400);
            const n = rage ? 5 : 3;
            for (let i = 0; i < n; i++) this.time.delayedCall(400 + i * 170, () => {
              if (b.state !== 'active' || b.mode !== 'crawl') return;
              this.fireShot('spore', b.x + (i - (n - 1) / 2) * 18, b.y + 20, 0, 40, { gravity: true, tint: 0xa7f070, life: 3000 });
              DT.Audio.sfx('poot');
            });
          } else if (m === 'spit') {
            for (let i = 0; i < (rage ? 4 : 3); i++) this.time.delayedCall(i * 200, () => b.state === 'active' && b.mode === 'crawl' && this.aimShot('spore', b.x, b.y + 16, 115, { tint: 0x38b764, life: 3000 }));
            DT.Audio.sfx('fire');
          } else this.bossSummon(rage ? 3 : 2);
        }
      } else if (b.mode === 'shake') {
        b.x += Math.sin(time / 25) * 0.8;
        body.reset(b.x, b.ceilY);
        if (time > b.modeAt) {
          b.mode = 'fall'; b.setFlipY(false);
          body.setAllowGravity(true); body.setVelocity(0, 60);
          b.x = DT.clamp(b.x, 40, 280);
        }
      } else if (b.mode === 'fall') {
        b.play(b.def.kind + '_struggle', true);
        if (body.blocked.down || body.touching.down) {
          b.mode = 'dazed'; b.modeAt = time + (rage ? 1900 : 2400);
          body.setVelocity(0, 0);
          this.cameras.main.shake(180, 0.01); DT.Audio.sfx('bump');
          [-1, 1].forEach(d => { const sh = this.fireShot('shock', b.x + d * 22, body.bottom - 5, d * 140, 0, { anim: 'shock_go', solidOnly: true, unbreakable: true, life: 2200 }); sh.isShock = true; });
          this.popText(b.x, b.y - 30, '어질어질~', 0xffcd75);
        }
      } else if (b.mode === 'dazed') {
        body.setVelocityX(0);
        b.angle = Math.sin(time / 120) * 8;
        if (time > b.nextStar) { b.nextStar = time + 300; this.fxStar.explode(1, b.x + Phaser.Math.Between(-14, 14), b.y - 26); }
        if (time > b.modeAt) { b.angle = 0; b.mode = 'climb'; body.setAllowGravity(false); }
      } else if (b.mode === 'climb') {
        b.play(b.def.kind + '_walk', true);
        body.setVelocity(0, -100);
        if (b.y <= b.ceilY) { body.reset(b.x, b.ceilY); b.mode = 'crawl'; b.setFlipY(true); b.nextAttack = Math.max(b.nextAttack, time + 1000); }
      }
    }

    /* ── 4월드: 순간이동하는 보스 (도깨비 등불왕) — 깜빡 사라졌다가 다른 발판 위에 나타나 불꽃을 뿌림 ── */
    bossAnchors() {
      const m = this.stage.map, out = [];
      for (let r = 4; r < m.length; r++) for (let c = 3; c <= 16; c += 2) {
        const ch = m[r][c], up = m[r - 1] && m[r - 1][c];
        if ((ch === '=' || ch === '#') && up === '.' && m[r - 2] && m[r - 2][c] === '.') out.push({ x: c * 16 + 8, y: r * 16 - 24 });
      }
      return out.length ? out : [{ x: 80, y: 200 }, { x: 240, y: 200 }];
    }
    updateBossWarp(b, time, rage) {
      const body = b.body, p = this.player;
      body.setVelocity(0, 0);
      b.play(b.def.kind + '_walk', true);
      if (b.mode === 'idle') {
        b.setFlipX(p.x < b.x);
        b.y = b.homeY !== undefined ? b.homeY + Math.sin(time / 300) * 2 : b.y;
        if (time > b.modeAt) {
          const m = this.bossPick(b, ['ring', 'aim', 'clones', 'aim', 'ring', 'summon']);
          this.bossWarn(b, 600);
          b.mode = 'cast'; b.modeAt = time + 600; b.move = m;
        }
      } else if (b.mode === 'cast') {
        if (time > b.modeAt) {
          const m = b.move;
          if (m === 'ring') {
            const n = rage ? 12 : 8;
            for (let i = 0; i < n; i++) { const a = i / n * Math.PI * 2; this.fireShot('fireball', b.x, b.y, Math.cos(a) * 85, Math.sin(a) * 85, { anim: 'fireball_fly', life: 3000 }); }
            DT.Audio.sfx('fire');
          } else if (m === 'aim') {
            for (let i = 0; i < (rage ? 4 : 3); i++) this.time.delayedCall(i * 220, () => b.state === 'active' && !b.ghost && this.aimShot('fireball', b.x, b.y, 125, { anim: 'fireball_fly', life: 3000 }));
            DT.Audio.sfx('fire');
          } else if (m === 'clones') this.bossClones(b, rage ? 3 : 2);
          else this.bossSummon(rage ? 3 : 2);
          b.mode = 'stay'; b.modeAt = time + (rage ? 1300 : 1900);
        }
      } else if (b.mode === 'stay') {
        b.setFlipX(p.x < b.x);
        if (time > b.modeAt) {
          b.mode = 'out'; b.ghost = true;
          this.tweens.add({ targets: b, alpha: 0, duration: 280 });
          b.modeAt = time + 520;
          DT.Audio.sfx('select');
        }
      } else if (b.mode === 'out') {
        if (time > b.modeAt) {
          // 플레이어와 너무 가깝지 않은 다른 자리로
          const far = b.anchors.filter(a => Math.abs(a.x - p.x) + Math.abs(a.y - p.y) > 80 && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) > 30);
          const a = Phaser.Utils.Array.GetRandom(far.length ? far : b.anchors);
          body.reset(a.x, a.y); b.homeY = a.y;
          this.fxPx.explode(10, a.x, a.y);
          this.tweens.add({ targets: b, alpha: 1, duration: 280, onComplete: () => { b.ghost = false; } });
          b.mode = 'idle'; b.modeAt = time + 900;
        }
      }
    }
    bossClones(b, n) {
      const spots = Phaser.Utils.Array.Shuffle(b.anchors.filter(a => Math.abs(a.x - b.x) > 40)).slice(0, n);
      spots.forEach((a, i) => {
        const c = this.physics.add.image(a.x, a.y, b.def.kind, 0).setScale(3.2).setTint(b.def.tint || 0xffffff).setAlpha(0).setDepth(5);
        c.body.setAllowGravity(false); c.isClone = true;
        this.tweens.add({ targets: c, alpha: 0.85, duration: 250 });
        this.physics.add.overlap(this.seeds, c, (x, y) => {
          const sd = x.isSeed ? x : y; if (!sd.active || !c.active) return;
          sd.destroy(); this.popText(c.x, c.y - 30, '가짜!', 0x94b0c2); this.fxPx.explode(10, c.x, c.y); c.destroy();
        });
        this.time.delayedCall(700 + i * 200, () => { if (c.active && b.state === 'active') this.aimShot('fireball', c.x, c.y, 110, { anim: 'fireball_fly', life: 3000 }); });
        this.time.delayedCall(2600, () => { if (c.active) this.tweens.add({ targets: c, alpha: 0, duration: 250, onComplete: () => c.destroy() }); });
      });
      this.popText(b.x, b.y - 34, '누가 진짜게?', 0xffcd75);
    }

    bossChoose(time, rage) {
      const b = this.boss;
      const MOVES = {
        mush: ['jump', 'spores', 'charge', 'summon', 'spores'],
        gob: ['rain', 'charge', 'jump', 'summon', 'rain'],
        frog: ['bigjump', 'spores', 'jump', 'summon', 'bigjump'],
        thief: ['charge', 'rain', 'spores', 'summon', 'charge']
      }[b.def.kind] || ['jump', 'spores', 'charge', 'summon'];
      let type = MOVES[Math.floor(Math.random() * MOVES.length)];
      if (type === b.lastMove && Math.random() < 0.6) type = MOVES[(MOVES.indexOf(type) + 1) % MOVES.length];
      b.lastMove = type;
      const dir = this.player.x < b.x ? -1 : 1;
      b.dir = dir;
      const warn = type === 'jump' || type === 'bigjump' ? 350 : 650;
      b.attack = { type, dir, at: time + warn, warn: true };
      this.emote(b, '!');
      DT.Audio.sfx('warn');
      if (type === 'jump' || type === 'bigjump') {
        this.time.delayedCall(warn, () => {
          if (b.state !== 'active') return;
          const big = type === 'bigjump';
          b.body.setVelocityY(big ? -430 : -320);
          b.body.setVelocityX(DT.clamp((this.player.x - b.x) * (big ? 1.4 : 1), -190, 190));
          b.shockOnLand = true; b.airborne = true;
        });
        b.attack.fired = true; b.attack = null;
        b.nextAttack = time + warn + Phaser.Math.Between(1800, 2600) * (rage ? 0.65 : 1);
      }
      if (type === 'charge') this.tweens.add({ targets: b, x: b.x - dir * 4, yoyo: true, repeat: 3, duration: 70 });
    }

    bossFire(A, rage) {
      const b = this.boss, p = this.player;
      if (A.type === 'spores') {
        const n = rage ? 7 : 5, base = Math.atan2(p.y - b.y, p.x - b.x);
        for (let i = 0; i < n; i++) {
          const a = base + (i - (n - 1) / 2) * 0.28, sp = 105;
          this.fireShot('spore', b.x + Math.cos(a) * 20, b.y + Math.sin(a) * 20 - 6, Math.cos(a) * sp, Math.sin(a) * sp, { tint: b.def.tint, life: 3200 });
        }
        DT.Audio.sfx('fire');
      } else if (A.type === 'rain') {
        const n = rage ? 6 : 4;
        for (let i = 0; i < n; i++) {
          const tx = i === 0 ? p.x : 30 + Math.random() * 260;
          this.time.delayedCall(i * 140, () => {
            if (b.state !== 'active') return;
            this.lob('peach', b.x, b.y - 20, tx, 212, 1.0 + Math.random() * 0.3, { tint: b.def.kind === 'gob' ? 0x566c86 : 0xffffff, scale: 1.4 });
            DT.Audio.sfx('throw');
          });
        }
      } else if (A.type === 'summon') {
        this.bossSummon(rage ? 3 : 2);
      }
    }

    bossSummon(n) {
      const b = this.boss;
      for (let i = 0; i < n; i++) {
        const kind = b.def.minions[Math.floor(Math.random() * b.def.minions.length)];
        const sx = DT.clamp(b.x + Phaser.Math.Between(-40, 40), 30, 290);
        const sy = DT.clamp(b.flipY ? b.y + 34 : (DT.ENEMY_DEFS[kind].fly ? b.y - 40 : b.y - 30), 44, this.mapH - 40);
        const e = this.spawnEnemy({ kind, x: sx, y: sy });
        e.body.setVelocity(Phaser.Math.Between(-90, 90), -230);
        this.time.delayedCall(450, () => { if (e.active && e.state === 'spawn') e.state = 'active'; });
      }
      this.emote(b, '!');
    }

    bossHit(src, amt) {
      const b = this.boss, now = this.time.now;
      amt = amt || 1;
      if (!b || b.state !== 'active') return;
      // 같은 구체에서 갈라진 짝 물결은 무적 시간 중에도 한 번 더 맞힐 수 있음
      const pair = src && src.isWave ? src.bornAt : null;
      const partner = pair !== null && b.lastPair === pair && !b.pairDone;
      if (now < b.invUntil && !partner) return;
      if (pair !== null) { if (partner) b.pairDone = true; else { b.lastPair = pair; b.pairDone = false; } }
      const before = b.hp;
      b.hp = Math.round((b.hp - amt) * 100) / 100;
      if (!partner) b.invUntil = now + 700;
      this.drawBossBar();
      const pts = Math.round(2000 * amt);
      this.addScore(pts);
      this.popText(b.x, b.y - 36, 'BOSS HIT! +' + pts, 0xffcd75, 1, 1000);
      this.cameras.main.shake(260, 0.012);
      this.hitStop(140);
      this.ring(b.x, b.y, 0xffffff, 2.2);
      this.fxStar.explode(20, b.x, b.y);
      DT.FX.play(this, 'poof', b.x, b.y + 20, { depth: 33 });
      DT.Audio.sfx('bosshit');
      b.body.setVelocity(((src && src.x < b.x) ? 1 : -1) * 120, -180);
      if (b.hp <= 0.001) this.bossDie();
      else if (before > b.maxHp / 2 && b.hp <= b.maxHp / 2) this.banner('BOSS ANGRY!', 0xb13e53, 2.2, 1000);
    }

    bossDie() {
      const b = this.boss;
      b.state = 'dead';
      this.eshots.clear(true, true);
      this.addScore(20000);
      DT.Audio.music(false);
      this.enemies.getChildren().slice().forEach(e => { if (e.state !== 'dead') this.killEnemy(e, e.x < b.x ? -1 : 1); });
      for (let i = 0; i < 6; i++) this.time.delayedCall(i * 220, () => {
        DT.FX.play(this, 'poof', b.x + Phaser.Math.Between(-24, 24), b.y + Phaser.Math.Between(-10, 30), { depth: 34 });
        this.fxStar.explode(14, b.x, b.y); DT.Audio.sfx('kill', i + 2); this.cameras.main.shake(160, 0.01);
      });
      this.time.delayedCall(1400, () => {
        this.banner('BOSS CLEAR! +20000', 0xffcd75, 2, 1600);
        b.body.checkCollision.none = true; b.setCollideWorldBounds(false); b.body.setAllowGravity(true); b.ghost = false; b.setAlpha(1);
        b.body.setVelocity(0, -200); b.setFlipY(true); b.crown.setVisible(false);
        this.cameras.main.flash(120, 255, 255, 255, true);
      });
    }

    spawnEnemy(spec) {
      const e = this.enemies.create(spec.x, spec.y, spec.kind, 0);
      e.setScale(DT.SPR);
      e.body.setSize(12, 14).setOffset(2, 2);
      e.setCollideWorldBounds(true);
      e.setDepth(6);
      e.kind = spec.kind; e.def = DT.ENEMY_DEFS[spec.kind];
      e.hp = e.def.hp; e.hits = 0; e.state = 'spawn'; e.angry = false;
      e.dir = spec.x < DT.W / 2 ? 1 : -1;
      e.nextAct = this.time.now + Phaser.Math.Between(1500, 3000);
      e.knockUntil = 0; e.lastHitAt = 0; e.nextDecayAt = 0; e.nextTick = 0; e.attackUntil = 0;
      e.shell = this.add.image(e.x, e.y, 'orb_' + this.hero).setVisible(false).setDepth(7).setScale(DT.SPR);
      e.flyer = !!e.def.fly;
      if (e.flyer) { e.body.setAllowGravity(false); e.baseY = spec.y; e.phase = Math.random() * 6; }
      e.play(spec.kind + '_walk');
      e.setAlpha(0);
      const puff = this.add.sprite(spec.x, spec.y, 'puff', 0).setDepth(12).setVisible(false);
      this.time.delayedCall(Phaser.Math.Between(100, 600), () => {
        puff.setVisible(true).play('fx_puff'); puff.once('animationcomplete', () => puff.destroy());
        if (e.active) e.setAlpha(1);
      });
      return e;
    }

    groundAhead(e, dir) {
      const x = e.x + (dir || e.dir) * 9 * DT.SPR;
      if (this.physics.overlapRect(x - 1, e.body.bottom + 1, 2, 4, false, true).length > 0) return true;
      // 경사로도 땅으로 인정 (경사로에는 물리 몸체가 없어서 따로 확인)
      return [0, 6, 12].some(dy => !!this.slopeAt(x, e.body.bottom + dy));
    }
    // 발판 끝에서 돌아서기. 양쪽이 다 끝이면(아주 작은 칸) 제자리에서 덜덜 떨지 말고 그냥 내려감
    edgeTurn(e, time) {
      if (this.groundAhead(e)) return;
      if (time < (e.turnLock || 0)) return;
      if (!this.groundAhead(e, -e.dir)) { e.turnLock = time + 900; return; }   // 작은 칸: 앞으로 걸어 내려감
      e.dir *= -1; e.turnLock = time + 250;
    }

    updateEnemy(e, time) {
      if (!e.active) return;
      if (e.kickTag && e.state !== 'sealed') e.kickTag.setVisible(false);
      if (e.dash && e.state !== 'active') this.showHalf(e, false);
      e.shell.setPosition(Math.round(e.x), Math.round(e.y));
      switch (e.state) {
        case 'spawn': e.body.setVelocityX(0); break;
        case 'active': this.enemyAI(e, time); this.updateSealGauge(e, time); break;
        case 'sealed': this.updateSealed(e, time); break;
        case 'rolling': this.updateRolling(e, time); break;
        case 'flying': this.updateFlying(e, time); break;
        default: break;
      }
    }

    enemyAI(e, time) {
      const b = e.body, onGround = b.blocked.down || b.touching.down || !!e.onSlope;
      // 봉인 게이지가 찰수록 느려짐 (구체에 갇히기 직전엔 거의 못 움직임)
      const slow = e.hits > 0 ? Math.max(0.3, 1 - 0.6 * e.hits / e.hp) : 1;
      const spd = e.def.speed * (e.angry ? T.ANGRY_MULT : 1) * (this.hurry ? 1.3 : 1) * slow;
      if (time < e.knockUntil) return;
      if (b.blocked.left) e.dir = 1; else if (b.blocked.right) e.dir = -1;
      const p = this.player;
      if (e.kind !== 'frog') e.play(e.kind + (e.hits > 0 ? '_struggle' : '_walk'), true);
      if (e.hits > 0) {
        if (time > (e.sweatAt || 0)) { e.sweatAt = time + 700; this.fxPx.emitParticleAt(e.x + Phaser.Math.Between(-5, 5), e.y - 10, 2); }
        if (this.struggleAI(e, time, onGround, spd)) { e.setFlipX(e.dir < 0); return; }
      }

      if (e.kind === 'mush') {
        if (onGround) this.edgeTurn(e, time);
        b.setVelocityX(e.dir * spd);
        if (onGround && time > e.nextAct) {
          b.setVelocityY(-170);
          e.nextAct = time + Phaser.Math.Between(2200, 4200);
          if (Math.random() < 0.5) this.emote(e, '?');
        }
      } else if (e.kind === 'gob') {
        if (onGround) {
          this.edgeTurn(e, time);
          b.setVelocityX(e.dir * spd * 0.6);
          if (time > e.nextAct) {
            e.dir = p.x < e.x ? -1 : 1;
            b.setVelocityY(p.y < e.y - 20 ? -300 : -200);
            b.setVelocityX(e.dir * spd * 2.4);
            e.nextAct = time + Phaser.Math.Between(1100, 2000) / (e.angry ? 1.4 : 1);
          }
        }
      } else if (e.kind === 'thief') {
        let target = p;
        let best = 130;
        this.frags.getChildren().forEach(f => {
          if (!f.active || f.collected) return;
          const d = Math.abs(f.x - e.x) + Math.abs(f.y - e.y) * 1.5;
          if (d < best) { best = d; target = f; }
        });
        if (onGround) {
          if (Math.abs(target.x - e.x) > 6) e.dir = target.x < e.x ? -1 : 1;
          b.setVelocityX(e.dir * spd);
          if (time > e.nextAct && target.y < e.y - 20 && Math.abs(target.x - e.x) < 60) {
            b.setVelocityY(-305);
            e.nextAct = time + 1400;
          }
        }
      }
      else if (e.kind === 'bird') {
        // 물결 모양으로 날며 플레이어 높이로 천천히 다가옴
        e.phase += 0.06;
        const vy0 = this.cameras.main.worldView.y;
        const ty = DT.clamp(p.y - 10, vy0 + 34, vy0 + 196);
        e.baseY += Math.sign(ty - e.baseY) * 0.25 * (e.angry ? 1.6 : 1);
        b.setVelocityX(e.dir * spd);
        b.setVelocityY((e.baseY + Math.sin(e.phase) * 14 - e.y) * 4);
      } else if (e.kind === 'frog') {
        if (onGround) {
          b.setVelocityX(0);
          if (time > e.nextAct) {
            e.dir = p.x < e.x ? -1 : 1;
            const weak = e.hits > 0 ? 0.55 : 1;
            b.setVelocityY((p.y < e.y - 20 ? -330 : -230) * weak);
            b.setVelocityX(e.dir * (e.angry ? 120 : 85) * weak);
            e.nextAct = time + Phaser.Math.Between(1300, 2300) / (e.angry ? 1.4 : 1);
          }
        }
        e.anims.stop();
        e.setFrame(onGround ? 0 : 1);
      } else if (e.kind === 'snail') {
        if (onGround) this.edgeTurn(e, time);
        b.setVelocityX(e.dir * spd);
      } else if (e.kind === 'rabbit' || e.kind === 'bat' || e.kind === 'hedge' || e.kind === 'lantern') {
        if (this.newAI(e, time, onGround, spd)) return;
      } else if (e.kind === 'dragon' || e.kind === 'monkey' || e.kind === 'puppy') {
        if (this.specialAI(e, time, onGround, spd)) return;
        if (onGround) this.edgeTurn(e, time);
        b.setVelocityX(e.dir * spd);
      }
      e.setFlipX(e.dir < 0);
    }

    /* ── 새 몬스터 4종 ── */
    newAI(e, time, onGround, spd) {
      const b = e.body, p = this.player;
      if (e.kind === 'rabbit') {
        // 깡총토끼: 플레이어가 위에 있으면 높이 뛰어 위 발판으로, 아래에 있으면 발판을 뚫고 아래로 쏙
        if (onGround) {
          this.edgeTurn(e, time);
          b.setVelocityX(e.dir * spd * 0.5);
          if (time > e.nextAct) {
            const dy = p.y - e.y;
            e.nextAct = time + Phaser.Math.Between(1000, 1800) / (e.angry ? 1.4 : 1);
            if (dy < -20 || (dy < 20 && Math.random() < 0.35)) {
              e.dir = p.x < e.x ? -1 : 1;
              b.setVelocity(e.dir * spd * 1.6, dy < -20 ? -390 : -260);
            } else if (dy > 20 && this.enemyOnOneWay(e)) {
              e.dropUntil = time + 260; b.setVelocityY(70);
            } else { e.dir = p.x < e.x ? -1 : 1; b.setVelocity(e.dir * spd * 1.4, -200); }
          }
        }
        e.anims.stop(); e.setFrame(e.hits > 0 ? (onGround ? 2 : 3) : (onGround ? 0 : 1));
      } else if (e.kind === 'bat') {
        // 동굴박쥐: 천장(발판 아래)에 거꾸로 매달려 있다가, 아래로 지나가면 휙 덮침
        if (!e.mode) { e.mode = 'hang'; e.home = { x: e.x, y: e.y }; }
        if (e.mode === 'hang') {
          b.setVelocity(0, 0); e.setFlipY(true); e.anims.stop(); e.setFrame(0);
          if (Math.abs(p.x - e.x) < 46 && p.y > e.y + 10 && p.y - e.y < 130 && time > e.nextAct) {
            e.mode = 'dive'; e.diveAt = time; e.setFlipY(false); this.emote(e, '!');
            const a = Phaser.Math.Angle.Between(e.x, e.y, p.x, p.y), v = spd * 2.3 * (e.angry ? 1.3 : 1);
            b.setVelocity(Math.cos(a) * v, Math.sin(a) * v); e.dir = Math.cos(a) < 0 ? -1 : 1;
          }
        } else {
          e.play('bat_' + (e.hits > 0 ? 'struggle' : 'walk'), true);
          if (e.mode === 'dive' && (time - e.diveAt > 750 || b.blocked.down)) e.mode = 'rise';
          if (e.mode === 'rise') {
            const dx = e.home.x - e.x, dy = e.home.y - e.y, d = Math.hypot(dx, dy);
            if (d < 4) { e.body.reset(e.home.x, e.home.y); e.mode = 'hang'; e.nextAct = time + 900; }
            else { b.setVelocity(dx / d * spd * 1.3, dy / d * spd * 1.3); e.dir = dx < 0 ? -1 : 1; }
          }
        }
        e.setFlipX(e.dir < 0);
        return true;
      } else if (e.kind === 'hedge') {
        // 가시도치: 가까이 가면 몸을 공처럼 말고 굴러옴. 말려 있을 땐 탄이 튕겨 나감
        if (e.curled && time > e.curlUntil) { e.curled = false; e.nextAct = time + 1500; }
        if (!e.curled && onGround && time > e.nextAct && Math.abs(p.x - e.x) < 70 && Math.abs(p.y - e.y) < 20 && e.hits === 0) {
          e.curled = true; e.curlUntil = time + 1500; e.dir = p.x < e.x ? -1 : 1; this.emote(e, '!');
          b.setVelocityY(-120);
        }
        if (e.curled) {
          e.anims.stop(); e.setFrame(4); e.angle += e.dir * 14;
          b.setVelocityX(e.dir * (e.angry ? 140 : 110));
          return true;
        }
        e.angle = 0;
        if (onGround) this.edgeTurn(e, time);
        b.setVelocityX(e.dir * spd);
      } else if (e.kind === 'lantern') {
        // 등불도깨비: 둥실둥실 다가오다가 몇 초마다 깜빡! 플레이어 근처로 순간이동
        if (!e.phase) e.phase = Math.random() * 6;
        e.phase += 0.05;
        if (e.ghost) { b.setVelocity(0, 0); return true; }
        const dx = p.x - e.x, ty = p.y - 26 + Math.sin(e.phase) * 8;
        e.dir = dx < 0 ? -1 : 1;
        b.setVelocity(e.dir * spd * (e.hits > 0 ? 0.4 : 1), (ty - e.y) * 1.2);
        if (time > e.nextAct && e.hits === 0) {
          e.nextAct = time + Phaser.Math.Between(3200, 4600) / (e.angry ? 1.3 : 1);
          e.ghost = true;
          this.tweens.add({ targets: e, alpha: 0, duration: 260, onComplete: () => {
            if (!e.active || e.state !== 'active') { e.ghost = false; e.setAlpha(1); return; }
            const v = this.cameras.main.worldView;
            const nx = DT.clamp(p.x + (Math.random() < 0.5 ? -1 : 1) * Phaser.Math.Between(40, 70), 24, DT.W - 24);
            const ny = DT.clamp(p.y - Phaser.Math.Between(20, 40), v.y + 30, v.y + 200);
            e.body.reset(nx, ny);
            this.fxPx.explode(6, nx, ny);
            this.tweens.add({ targets: e, alpha: 1, duration: 260, onComplete: () => { e.ghost = false; } });
          } });
        }
      }
      return false;
    }
    enemyOnOneWay(e) {
      const hits = this.physics.overlapRect(e.body.x + 1, e.body.bottom + 1, e.body.width - 2, 3, true, true);
      return hits.length > 0 && hits.every(bd => bd.gameObject && (bd.gameObject.oneWay || bd.gameObject.crumble));
    }

    /* ── 봉인되기 직전: 몬스터마다 다르게 버둥거림 ── */
    struggleAI(e, time, onGround, spd) {
      const b = e.body, p = this.player;
      switch (e.kind) {
        case 'gob': // 제자리에서 폴짝폴짝 털어내려 함
          if (onGround && time > (e.strugNext || 0)) { e.strugNext = time + 360; b.setVelocity(Phaser.Math.Between(-35, 35), -150); }
          return true;
        case 'thief': // 플레이어 반대쪽으로 도망
          e.dir = p.x < e.x ? 1 : -1; b.setVelocityX(e.dir * spd * 1.3); return true;
        case 'snail': // 껍데기 속에 쏙 숨어 꼼짝 안 함
          b.setVelocityX(0); e.anims.stop(); e.setFrame(2); return true;
        case 'monkey': // 부르르 떨며 제자리
          b.setVelocityX(Math.floor(time / 90) % 2 ? 22 : -22); return true;
        case 'puppy': // 허둥지둥 빙글빙글
          if (time > (e.strugNext || 0)) { e.strugNext = time + 380; e.dir *= -1; }
          b.setVelocityX(e.dir * spd * 1.4); return true;
        case 'bird': // 날갯짓이 엉망이 되어 점점 아래로
          e.baseY = Math.min(e.baseY + 0.35, this.cameras.main.worldView.y + 200); e.phase += 0.08; return false;
        case 'dragon': // 불 대신 연기만 콜록
          if (time > (e.strugNext || 0)) { e.strugNext = time + 600; this.fxDust.explode(3, e.x + e.dir * 10, e.y - 2); }
          return false;
        default: return false; // 혼동버섯 · 개구리: 느려지기만 (개구리는 점프가 약해짐)
      }
    }

    /* ── 몬스터 탄 ── */
    fireShot(key, x, y, vx, vy, opt) {
      opt = opt || {};
      if (!opt.noWallCheck && this.solidAt(x, y)) {   // 몬스터가 벽에 붙어 쏘면 벽 속에서 생기지 않게: 그 자리에서 퍽
        this.fxPx.explode(4, x, y);
        return { isShot: true, active: false };   // 호출한 쪽이 속성을 붙여도 문제없는 빈 탄
      }
      const sh = this.eshots.create(x, y, key, 0);
      sh.isShot = true; sh.bornAt = this.time.now; sh.life = opt.life || 2600;
      sh.solidOnly = !!opt.solidOnly; sh.unbreakable = !!opt.unbreakable;
      sh.setDepth(14).setScale(opt.scale || 1);
      if (opt.tint) sh.setTint(opt.tint);
      sh.body.setAllowGravity(!!opt.gravity);
      sh.body.setSize(sh.width * 0.8, sh.height * 0.8);
      sh.body.setVelocity(vx, vy);
      if (opt.anim) sh.play(opt.anim);
      if (opt.spin) sh.body.setAngularVelocity(opt.spin);
      sh.setFlipX(vx < 0);
      return sh;
    }
    popShot(sh) {
      if (!sh || !sh.active) return;
      this.fxPx.explode(5, sh.x, sh.y);
      sh.destroy();
    }
    sweepPoop(pp) {
      if (!pp.active) return;
      this.fxDust.explode(6, pp.x, pp.y);
      this.fxStar.explode(2, pp.x, pp.y - 4);
      this.popText(pp.x, pp.y - 10, '깨끗!', 0xa7f070);
      this.addScore(30);
      DT.Audio.sfx('collect');
      pp.destroy();
    }
    // 포물선으로 (tx,ty)에 떨어지도록 던지기
    lob(key, x, y, tx, ty, flight, opt) {
      const g = T.GRAVITY, t = flight || 0.9;
      const vx = DT.clamp((tx - x) / t, -170, 170);
      const vy = Math.max(-400, (ty - y - 0.5 * g * t * t) / t);
      return this.fireShot(key, x, y, vx, vy, Object.assign({ gravity: true, spin: vx < 0 ? -500 : 500 }, opt || {}));
    }
    updateShots(time) {
      this.eshots.getChildren().slice().forEach(sh => {
        if (!sh.active) return;
        if (time - sh.bornAt > sh.life || sh.x < -20 || sh.x > DT.W + 20 || sh.y > this.mapH + 20) sh.destroy();
        else if (sh.isShock && Math.abs(sh.body.velocity.x) < 5) this.popShot(sh);
      });
      // 굴러가는 구체·퐁이 물결이 지나가면 똥이 깨끗이 쓸려 나감
      // (밀어서 천천히 굴러가는 봉인 구체도 포함)
      const sweepers = this.enemies.getChildren().filter(e => e.active && (e.state === 'rolling' || e.state === 'flying' ||
        (e.state === 'sealed' && (Math.abs(e.body.velocity.x) > 4 || e.pushedAt >= time - 50)))).concat(this.waves.getChildren().filter(w => w.active));
      this.poops.getChildren().slice().forEach(pp => {
        if (!pp.active) return;
        if (sweepers.some(o => Math.abs(o.x - pp.x) < 18 && Math.abs(o.y - pp.y) < 18)) { this.sweepPoop(pp); return; }
        const age = time - pp.bornAt;
        if (age > 7500) pp.setVisible(Math.floor(time / 100) % 2 === 0);
        if (age > 9000 || (this.climb && pp.y > this.hazardY)) pp.destroy();
      });
    }

    // 불뿜이 · 던짐원숭이 · 똥강아지 공격
    specialAI(e, time, onGround, spd) {
      const p = this.player, b = e.body;
      const dx = p.x - e.x, dy = p.y - e.y;
      if (time < e.attackUntil) { b.setVelocityX(0); return true; }
      if (e.hits > 0) return false;
      if (e.kind === 'dragon') {
        if (onGround && time > e.nextAct && Math.abs(dy) < 26 && Math.abs(dx) < 220) {
          e.dir = dx < 0 ? -1 : 1; e.setFlipX(e.dir < 0);
          e.attackUntil = time + 700; e.nextAct = time + Phaser.Math.Between(2600, 4200) / (e.angry ? 1.4 : 1);
          this.emote(e, '!');
          e.setTintFill(0xffcd75); this.time.delayedCall(140, () => this.applyTint(e)); this.time.delayedCall(280, () => { if (e.active) e.setTintFill(0xffcd75); }); this.time.delayedCall(400, () => this.applyTint(e));
          this.time.delayedCall(420, () => {
            if (!e.active || e.state !== 'active') return;
            this.fireShot('fireball', e.x + e.dir * 12, e.y + 1, e.dir * 135, 0, { anim: 'fireball_fly', solidOnly: true, scale: DT.SPR });
            DT.Audio.sfx('fire');
          });
          return true;
        }
      } else if (e.kind === 'monkey') {
        if (onGround && time > e.nextAct && Math.abs(dx) < 230 && Math.abs(dy) < 120) {
          e.dir = dx < 0 ? -1 : 1; e.setFlipX(e.dir < 0);
          e.attackUntil = time + 500; e.nextAct = time + Phaser.Math.Between(2400, 3800) / (e.angry ? 1.4 : 1);
          e.anims.stop(); e.setFrame(1);
          this.time.delayedCall(250, () => {
            if (!e.active || e.state !== 'active') return;
            this.lob('peach', e.x, e.y - 8, p.x + Phaser.Math.Between(-12, 12), p.y, 0.85 + Math.random() * 0.2, { scale: DT.SPR });
            DT.Audio.sfx('throw');
            e.play('monkey_walk');
          });
          return true;
        }
      } else if (e.kind === 'puppy') {
        if (onGround && time > e.nextAct && this.poops.countActive(true) < 7) {
          e.nextAct = time + Phaser.Math.Between(2600, 4000);
          e.attackUntil = time + 300;
          const pp = this.poops.create(e.x - e.dir * 9, e.y + 4, 'poop');
          pp.isPoop = true; pp.bornAt = time; pp.setDepth(4).setScale(DT.SPR);
          pp.body.setSize(8, 5).setOffset(0, 2);
          DT.Audio.sfx('poot');
          this.emote(e, '♥');
          return true;
        }
      }
      return false;
    }

    updateSealGauge(e, time) {
      if (e.hits > 0 && time - e.lastHitAt > T.HIT_DECAY_DELAY && time > e.nextDecayAt) {
        e.hits--; e.nextDecayAt = time + T.HIT_DECAY_STEP;
      }
      e.shell.setVisible(false);
      this.showHalf(e, e.hits > 0);
    }

    // 반쯤 봉인(버둥거림): 구체 없이 점선 테두리만 빙글빙글 — 완성된 구체(꽉 찬 공)와 확실히 다르게
    showHalf(e, on) {
      if (!e.dash) {
        e.dash = this.add.image(0, 0, 'orb_dash').setDepth(7).setScale(DT.SPR).setAlpha(0.6);
        e.once('destroy', () => { if (e.dash) e.dash.destroy(); });
      }
      e.dash.setVisible(on);
      if (on) e.dash.setPosition(Math.round(e.x), Math.round(e.y)).setRotation(this.time.now / 500);
    }

    hintText(str) {
      const t = DT.text(this, 160, 200, str, { font: 'ko', size: 10, color: '#ffffff', strokeThickness: 3, depth: 60 });
      this.ui.add(t);
      this.tweens.add({ targets: t, alpha: 0, delay: 2200, duration: 400, onComplete: () => t.destroy() });
    }

    emote(e, ch) {
      const t = DT.ptext(this, e.x, e.y - 12, ch, { ox: 0.5, oy: 1, tint: ch === '!' ? 0xef7d57 : 0x73eff7, depth: 44 });
      this.tweens.add({ targets: t, y: t.y - 6, alpha: 0, delay: 350, duration: 400, onComplete: () => t.destroy() });
    }

    applyTint(e) {
      if (!e.active) return;
      if (e.angry && e.state === 'active') e.setTint(0xff9a8a); else e.clearTint();
    }

    onSeedEnemy(a, b) {
      const s = a.isSeed ? a : b, e = a.isSeed ? b : a;
      if (!s.active || !e.active || !s.isSeed) return;
      if (s.hitSet.indexOf(e) >= 0) return;          // 꿰뚫기: 같은 몬스터는 한 번만
      if (e.ghost) return;                             // 사라지는 중인 등불도깨비는 통과
      if (e.curled && e.state === 'active') {          // 공처럼 말린 가시도치: 탄이 팅!
        this.popText(e.x, e.y - 12, '팅!', 0xf4f4f4); DT.Audio.sfx('tick');
        s.body.setVelocityX(-s.body.velocity.x * 0.6); s.body.setVelocityY(-120); s.isSeed = false; s.setAlpha(0.6);
        this.time.delayedCall(250, () => s.active && s.destroy());
        return;
      }
      const dir = s.dir;
      let dmg = s.dmg;
      if (e.state === 'active' && this.S.crit && Math.random() < this.S.crit) { dmg *= 2; this.popText(e.x, e.y - 14, '2배!', 0xffcd75); }
      this.fxPx.explode(5, s.x, s.y);
      if (s.pierceLeft > 0 && e.state === 'active') { s.pierceLeft--; s.hitSet.push(e); }
      else s.destroy();
      if (e.state === 'active') this.hitEnemy(e, dir, dmg);
      else if (e.state === 'sealed') {
        // 구체는 씨앗탄으로 날릴 수 없음: 봉인 시간만 조금 늘어남 (직접 밀어야 함)
        e.sealedAt = Math.min(this.time.now, e.sealedAt + 400);
        e.shell.setTintFill(0xffffff); this.time.delayedCall(50, () => e.active && e.shell.clearTint());
        DT.Audio.sfx('tick');

      }
    }

    hitEnemy(e, dir, dmg) {
      const now = this.time.now;
      e.hits += dmg; e.lastHitAt = now;
      e.setTintFill(0xffffff);
      this.time.delayedCall(60, () => this.applyTint(e));
      e.knockUntil = now + 110;
      e.body.setVelocityX(dir * 55);
      this.fxStar.explode(2, e.x, e.y);
      DT.Audio.sfx('hit', e.hits);
      this.addScore(10);
      if (e.hits >= e.hp) this.sealEnemy(e);
    }

    sealEnemy(e) {
      const now = this.time.now;
      e.state = 'sealed'; e.sealedAt = now; e.hits = 0; e.nextTick = 0;
      e.clearTint();
      e.curled = false; e.ghost = false; e.angle = 0; e.setAlpha(1); this.tweens.killTweensOf(e);
      if (e.kind === 'bat') { e.setFlipY(false); e.mode = 'rise'; }
      e.body.setVelocity(0, -70);
      e.body.setAllowGravity(true);
      e.body.pushable = false;
      if (!this.sealHintShown) { this.sealHintShown = true; this.hintText('구체에 다가가 공격 버튼으로 차요! 밀거나 위에 올라탈 수도 있어요'); }
      e.play(e.kind + '_struggle');
      e.shell.setVisible(true).setAlpha(1).setScale(1.7 * DT.SPR).setRotation(0);
      this.tweens.add({ targets: e.shell, scale: DT.SPR, duration: 260, ease: 'Back.easeOut' });
      this.showHalf(e, false);
      if (!e.kickTag) {
        e.kickTag = DT.text(this, e.x, e.y - 16 * DT.SPR, '차기!', { font: 'ko', size: 8, color: '#a7f070', strokeThickness: 2, depth: 13 });
        this.tweens.add({ targets: e.kickTag, alpha: 0.35, yoyo: true, repeat: -1, duration: 260 });
        e.once('destroy', () => { if (e.kickTag) e.kickTag.destroy(); });
      }
      e.kickTag.setVisible(true);
      this.ring(e.x, e.y, 0xa7f070, 1);
      this.fxLeaf.explode(10, e.x, e.y);
      this.popText(e.x, e.y - 14, '+100', 0xa7f070);
      this.addScore(100);
      this.hitStop(35);
      DT.Audio.sfx('seal');
    }

    updateSealed(e, time) {
      const b = e.body, pushed = e.pushedAt === time;
      if (e.kickTag) e.kickTag.setPosition(Math.round(e.x), Math.round(e.y - 16 * DT.SPR - 2 + Math.sin(time / 150) * 1.5));
      if (e.onSlope && !pushed) b.setVelocityX(DT.clamp(b.velocity.x + e.onSlope.down * 260 * this.game.loop.delta / 1000, -150, 150));
      else if (!pushed && time > (e.inchUntil || 0)) b.setVelocityX(b.velocity.x * 0.85);
      const left = this.S.sealTime + (e.kind === 'snail' ? 1500 : 0) - (time - e.sealedAt);
      const warn = left < T.SEAL_WARN;
      // 빠져나가려는 몸부림 (풀리기 직전일수록 자주)
      if (!pushed && time > (e.strugNext || 0)) {
        e.strugNext = time + (warn ? 450 : 1100) + Math.random() * 300;
        const onG = b.blocked.down || b.touching.down;
        if (['gob', 'frog', 'monkey', 'puppy'].indexOf(e.kind) >= 0 && onG) { b.setVelocityY(e.kind === 'frog' ? -170 : -110); DT.Audio.sfx('tick'); }
        else if (e.kind === 'thief' || e.kind === 'mush') { b.setVelocityX((Math.random() < 0.5 ? -1 : 1) * 28); e.inchUntil = time + 220; }
        else if (e.kind === 'bird' && onG) b.setVelocityY(-80);
        else if (e.kind === 'dragon') this.fxDust.explode(4, e.x, e.y - 10);
      }
      e.shell.x += Math.round(Math.sin(time / (warn ? 30 : 90)) * (warn ? 1.5 : 0.6));
      e.x !== undefined && e.setFlipX(Math.floor(time / 300) % 2 === 0);
      if (warn) {
        e.shell.setAlpha(Math.floor(time / 90) % 2 ? 0.45 : 0.95);
        if (time > e.nextTick) { DT.Audio.sfx('tick'); e.nextTick = time + 380; }
      }
      if (left <= 0) this.unseal(e);
    }

    unseal(e) {
      e.state = 'active'; e.angry = true; e.hits = 0; e.body.pushable = true;
      e.shell.setVisible(false).setAlpha(1);
      e.play(e.kind + '_walk');
      e.body.setVelocityY(-160);
      if (e.flyer) { e.body.setAllowGravity(false); e.baseY = e.y - 20; }
      this.fxPx.explode(10, e.x, e.y);
      this.emote(e, '!');
      this.applyTint(e);
      DT.Audio.sfx('unseal');
    }

    launchOrb(e, dir) {
      e.body.pushable = true;
      const kind = this.heroDef.orb;
      if (kind === 'blast') return this.blastOrb(e, dir);
      if (kind === 'wave') return this.waveOrb(e, dir);
      const now = this.time.now;
      e.state = 'rolling'; e.rollDir = dir; e.combo = 1; e.bounces = 0; e.rolledAt = now; e.nextTrail = 0;
      e.shell.setAlpha(1).setVisible(true);
      e.body.setVelocity(dir * this.S.orbSpeed, -70);
      this.ring(e.x, e.y, 0xffcd75, 1);
      this.fxStar.explode(4, e.x, e.y);
      this.cameras.main.shake(80, 0.003);
      this.hitStop(45);
      DT.Audio.sfx('kick');
    }

    updateRolling(e, time) {
      const b = e.body;
      if ((b.blocked.left && e.rollDir < 0) || (b.blocked.right && e.rollDir > 0)) {
        e.rollDir *= -1; e.bounces++;
        this.fxDust.explode(6, e.x - e.rollDir * 8, e.y);
        this.cameras.main.shake(60, 0.002);
        DT.Audio.sfx('bump');
        if (e.bounces > this.S.orbBounces) { this.burstOrb(e); return; }
      }
      b.setVelocityX(e.rollDir * this.S.orbSpeed);
      e.shell.rotation += e.rollDir * 0.35;
      e.rotation = e.shell.rotation;
      if (time > e.nextTrail) { this.fxLeaf.emitParticleAt(e.x - e.rollDir * 8, e.y + 4, 1); e.nextTrail = time + 45; }
      if (time - e.rolledAt > T.ROLL_MAX_TIME) this.burstOrb(e);
    }

    onEnemyEnemy(a, b) {
      const hittable = (x) => x.state === 'active' || x.state === 'sealed' || x.state === 'spawn';
      if (a.state === 'rolling' && hittable(b)) this.orbHit(a, b);
      else if (b.state === 'rolling' && hittable(a)) this.orbHit(b, a);
    }

    // 날아가는 구체가 다른 몬스터와 충돌 → 연쇄 처치
    orbHit(orb, victim) { this.chainKill(orb, victim); }

    // 구체·폭발·물결 공통: 연쇄 n번째 처치
    chainKill(src, victim) {
      src.combo++;
      const n = src.combo, pts = Math.round(T.COMBO_BASE * n * (this.S.comboMul || 1) / 10) * 10, orb = src;
      this.killEnemy(victim, orb.rollDir || (victim.x < src.x ? -1 : 1));
      this.addScore(pts);
      this.comboText(victim.x, victim.y, n, pts);
      this.registerCombo(n);
      this.hitStop(55 + n * 12);
      this.cameras.main.shake(110, 0.004 + 0.0015 * n);
      if (!DT.FX.play(this, 'poof', victim.x, victim.y + 8 * DT.SPR, { depth: 33, scale: 0.75 })) this.ring(victim.x, victim.y, 0xffffff, 1 + n * 0.15);
      this.fxStar.explode(8 + n * 3, victim.x, victim.y);
      DT.Audio.sfx('kill', n);
    }

    // 도토: 차면 앞으로 포물선을 그리며 날아가다가 땅·벽·몬스터에 닿으면 펑! 범위 안의 적을 모두 연쇄 처치
    blastOrb(e, dir) {
      if (e.state !== 'sealed') return;
      e.state = 'flying'; e.combo = 1; e.rollDir = dir; e.flyAt = this.time.now;
      e.body.setAllowGravity(true);
      // 둥실: 중력을 줄여 약 0.9초 동안 살짝 떴다가 2~3칸 앞에 떨어지며 펑
      e.body.setGravityY(-320);
      e.body.setVelocity(dir * (50 + this.S.orbSpeed * 0.06), -190);
      this.tweens.add({ targets: e.shell, scale: DT.SPR * 1.12, yoyo: true, repeat: 2, duration: 140 });
      e.shell.setAlpha(1);
      DT.Audio.sfx('kick');
    }
    updateFlying(e, time) {
      const b = e.body, age = time - e.flyAt;
      e.shell.rotation += e.rollDir * 0.3; e.rotation = e.shell.rotation;
      if (time > (e.nextTrail || 0)) { this.fxLeaf.emitParticleAt(e.x, e.y, 1); e.nextTrail = time + 40; }
      const landed = age > 300 && (b.blocked.down || b.touching.down || !!e.onSlope);
      const wall = b.blocked.left || b.blocked.right;
      const hitEnemy = age > 150 && this.enemies.getChildren().some(o => o !== e && o.active && (o.state === 'active' || o.state === 'sealed' || o.state === 'spawn') &&
        Math.abs(o.x - e.x) < 16 && Math.abs(o.y - e.y) < 16);
      const hitBoss = this.boss && this.boss.state === 'active' && Math.abs(this.boss.x - e.x) < 30 && Math.abs(this.boss.y - e.y) < 34;
      if (landed || wall || hitEnemy || hitBoss || age > 1600) this.explodeBlast(e);
    }
    explodeBlast(e) {
      if (e.state !== 'flying') return;
      e.state = 'blasting';
      e.body.setVelocity(0, 0); e.body.setGravityY(0);
      e.shell.setTintFill(0xffffff);
      const R = 40 + (this.S.orbBounces - 2) * 8 + (this.S.blastR || 0);
      this.ring(e.x, e.y, 0xffcd75, R / 14);
      this.cameras.main.shake(220, 0.009);
      this.cameras.main.flash(80, 255, 236, 180);
      this.hitStop(80);
      const targets = this.enemies.getChildren().filter(o => o !== e && o.active &&
        (o.state === 'active' || o.state === 'sealed' || o.state === 'spawn') && Phaser.Math.Distance.Between(o.x, o.y, e.x, e.y) <= R);
      targets.sort((a, b) => Phaser.Math.Distance.Between(a.x, a.y, e.x, e.y) - Phaser.Math.Distance.Between(b.x, b.y, e.x, e.y));
      targets.forEach((o, i) => this.time.delayedCall(i * 70, () => { if (o.active && o.state !== 'dead') this.chainKill(e, o); }));
      this.poops.getChildren().slice().forEach(pp => { if (pp.active && Phaser.Math.Distance.Between(pp.x, pp.y, e.x, e.y) <= R) this.sweepPoop(pp); });
      if (this.boss && this.boss.state === 'active' && Phaser.Math.Distance.Between(this.boss.x, this.boss.y, e.x, e.y) <= R + 26) this.bossHit(e);
      e.state = 'rolling';
      e.shell.clearTint();
      this.burstOrb(e);
    }

    // 퐁이: 구체가 터져 물결이 되어 바닥을 따라 흘러감
    // 퐁이: 구체가 터지면 물이 양쪽으로 쏴아— 갈라져 흘러감 (두 물결이 연쇄 점수를 함께 셈)
    waveOrb(e, dir) {
      if (e.state !== 'sealed') return;
      const shared = { n: 1 };
      [dir, -dir].forEach((d, i) => {
        const w = this.waves.create(e.x + d * 4, e.y, 'wave', 0);
        Object.defineProperty(w, 'combo', { get: () => shared.n, set: (v) => { shared.n = v; }, configurable: true });
        w.isWave = true; w.dir = d; w.rollDir = d; w.bornAt = this.time.now; w.nextFrame = 0; w.bounces = 0;
        w.setScale(DT.SPR).setDepth(12).setFlipX(d < 0);
        w.body.setSize(8, 14).setOffset(10, 6);   // 몸통은 좁게 → 한 칸 틈으로도 물이 흘러내림
        w.body.setVelocity(d * this.S.orbSpeed * (i ? 0.8 : 0.9), -40);
        w.life = 2400 + (this.S.orbBounces - 2) * 800;
        w.isMain = i === 0;
      });
      DT.Audio.sfx('kick');
      this.ring(e.x, e.y, 0x73eff7, 1.2);
      this.cameras.main.shake(100, 0.004);
      // 봉인된 몬스터는 물결의 첫 희생자
      e.state = 'rolling'; e.combo = 0;
      this.killEnemy(e, dir);
      this.addScore(T.COMBO_BASE);
      this.popText(e.x, e.y - 10, '+' + T.COMBO_BASE, 0x73eff7);
      this.registerCombo(1);
    }

    updateWave(w, time) {
      if (!w.active) return;
      const b = w.body;
      const onG = b.blocked.down || b.touching.down || !!w.onSlope;
      if (!onG && b.velocity.y > 40) {
        // 떨어지는 중: 가늘고 길게 (폭포)
        w.setScale(DT.SPR * 0.55, DT.SPR * 1.35);
        if (Math.random() < 0.6) this.fxPx.emitParticleAt(w.x + Phaser.Math.Between(-3, 3), w.y - 6, 1);
        w.wasFalling = true;
      } else if (onG && w.wasFalling) {
        // 착지: 첨벙! 같은 방향으로 계속 흐름
        w.wasFalling = false;
        w.setScale(DT.SPR);
        this.fxPx.explode(10, w.x, w.y + 6);
        DT.Audio.sfx('shoot', 'line');
      }
      // 넓은 물결 범위로 적 휩쓸기 (몸통이 좁아도 그림만큼 판정)
      this.enemies.getChildren().forEach(e => {
        if (e.active && (e.state === 'active' || e.state === 'sealed' || e.state === 'spawn') && Math.abs(e.x - w.x) < 18 && Math.abs(e.y - w.y) < 16) this.chainKill(w, e);
      });
      if (w.onSlope && w.dir !== w.onSlope.down) { w.dir = w.onSlope.down; w.rollDir = w.dir; w.setFlipX(w.dir < 0); }   // 경사로에서는 아래쪽으로 흐름
      if ((b.blocked.left && w.dir < 0) || (b.blocked.right && w.dir > 0)) {
        w.bounces++;
        this.fxPx.explode(8, w.x + w.dir * 10, w.y);
        if (w.bounces > 1) { this.endWave(w); return; }
        w.dir *= -1; w.rollDir = w.dir; w.setFlipX(w.dir < 0);
      }
      b.setVelocityX(w.dir * this.S.orbSpeed * 0.9);
      if (time > w.nextFrame) { w.setFrame(w.frame.name === 0 ? 1 : 0); w.nextFrame = time + 110; this.fxPx.emitParticleAt(w.x - w.dir * 10, w.y + 6, 2); }
      const age = time - w.bornAt;
      if (age > w.life - 500) w.setAlpha((w.life - age) / 500);
      if (age > w.life || w.y > this.mapH + 20) this.endWave(w);
    }

    waveHit(w, e) {
      if (!w.active || !e.active) return;
      if (e.state === 'active' || e.state === 'sealed' || e.state === 'spawn') this.chainKill(w, e);
    }

    endWave(w) {
      if (!w.active) return;
      const n = w.combo;
      this.fxPx.explode(14, w.x, w.y);
      DT.FX.play(this, 'poof', w.x, w.y + 10, { depth: 33, scale: 0.6 });
      DT.Audio.sfx('bump');
      const other = this.waves.getChildren().some(o => o !== w && o.active && o.bornAt === w.bornAt);
      if (!other && n >= 3) this.banner(n >= 4 ? 'FANTASTIC!' : 'GREAT!', 0x73eff7, 2.5);
      w.destroy();
    }

    burstOrb(e) {
      if (e.state !== 'rolling') return;
      const n = e.combo;
      this.killEnemy(e, e.rollDir);
      this.addScore(T.COMBO_BASE);
      this.popText(e.x, e.y - 10, '+' + T.COMBO_BASE, 0xffcd75);
      this.registerCombo(n);
      DT.FX.play(this, 'poof', e.x, e.y + 8 * DT.SPR, { depth: 33 }) || this.ring(e.x, e.y, 0xffcd75, 1.6);
      this.fxStar.explode(16, e.x, e.y);
      this.fxLeaf.explode(12, e.x, e.y);
      this.cameras.main.shake(160, 0.006);
      DT.Audio.sfx('burst');
      if (!this.boss && n >= this.stageEnemyTotal && n >= 3) {
        this.time.delayedCall(250, () => {
          this.banner('PERFECT!', 0x73eff7, 3, 1200);
          this.popText(160, 140, '+10000', 0xffcd75, 2, 1400);
          this.addScore(10000);
          this.cameras.main.flash(120, 255, 255, 255);
          DT.Audio.sfx('perfect');
        });
      } else if (n >= 4) this.time.delayedCall(200, () => this.banner('FANTASTIC!', 0xef7d57, 2.5));
      else if (n >= 3) this.time.delayedCall(200, () => this.banner('GREAT!', 0xa7f070, 2.5));
    }

    killEnemy(e, dir) {
      if (e.state === 'dead') return;
      const wasOrb = e.state === 'sealed' || e.state === 'rolling';
      e.state = 'dead';
      if (wasOrb) this.fxPx.explode(12, e.x, e.y);
      e.shell.setVisible(false);
      e.clearTint();
      e.play(e.kind + '_struggle');
      e.setFlipY(true);
      e.setCollideWorldBounds(false);
      e.body.checkCollision.none = true;
      e.body.setAllowGravity(true);
      e.body.setVelocity(dir * Phaser.Math.Between(60, 120), -230);
      e.body.setAngularVelocity(dir * 540);
      e.setDepth(20);
      const lucky = wasOrb || e.state === 'dead';
      this.time.delayedCall(650, () => {
        const fx = DT.clamp(e.x, 28, 292), fy = DT.clamp(e.y, 28, this.mapH - 40);
        this.spawnFragment(fx, fy);
        if (lucky && this.S.luck && Math.random() < this.S.luck) this.spawnHeart(fx, fy);
        e.shell.destroy();
        e.destroy();
      });
    }

    registerCombo(n) {
      this.chainCombo = Math.max(n, this.time.now < this.chainUntil ? this.chainCombo : 0);
      this.chainUntil = this.time.now + 2200;
      this.maxCombo = Math.max(this.maxCombo, n);
    }

    /* ───────────── 플레이어 피격 ───────────── */
    onPlayerEnemy(a, b) {
      const e = a === this.player ? b : a;
      if (e.state !== 'active' || this.dead || this.cleared || e.ghost) return;
      if (this.time.now < this.invUntil) return;
      if (e.hits > 0) {
        // 버둥거리는 중: 아프지 않고 서로 툭 밀려남
        if (this.time.now < (this.bumpUntil || 0)) return;
        this.bumpUntil = this.time.now + 300;
        const d = this.player.x < e.x ? -1 : 1;
        this.player.body.setVelocity(d * 130, -110);
        this.knockUntil = this.time.now + 160;
        e.body.setVelocityX(-d * 40); e.knockUntil = this.time.now + 160;
        DT.Audio.sfx('bump');
        return;
      }
      this.hurtPlayer(e);
    }

    hurtPlayer(e) {
      const now = this.time.now, p = this.player;
      if (this.shieldLeft > 0) {   // 나뭇잎 방패: 한 번 막아 줌
        this.shieldLeft--;
        this.invUntil = now + 900;
        const d = p.x < e.x ? -1 : 1;
        p.body.setVelocity(d * 120, -150); this.knockUntil = now + 180;
        this.popText(p.x, p.y - 16, '방패!', 0xa7f070);
        this.ring(p.x, p.y, 0xa7f070, 1);
        DT.Audio.sfx('bump');
        this.refreshShield();
        return;
      }
      this.hp--;
      if (this.dropkick) { this.dropkick = false; this.dk = null; p.setAngle(0); }
      this.invUntil = now + T.INVINCIBLE_MS + (this.S.invBonus || 0);
      this.hurtUntil = now + 350;
      this.knockUntil = now + 260;
      const dir = p.x < e.x ? -1 : 1;
      p.body.setVelocity(dir * 140, -200);
      this.cameras.main.shake(180, 0.008);
      this.cameras.main.flash(90, 177, 62, 83);
      this.hitStop(90);
      DT.Audio.sfx('hurt');
      if (this.hp <= 0) this.die();
    }

    die() {
      if (this.dead) return;
      this.dead = true; this.fireLocked = true;
      const p = this.player;
      this.carried = null; p.body.setAllowGravity(true);
      p.play(this.hero + '_hurt');
      p.setCollideWorldBounds(false);
      p.body.checkCollision.none = true;
      p.body.setVelocity(0, -280);
      DT.Audio.music(false);
      DT.Audio.sfx('die');
      DT.saveHi(this.score);
      this.time.delayedCall(1700, () => {
        this.run.score = this.score; this.run.learned = this.learned; this.run.maxCombo = this.maxCombo;
        this.scene.start('GameOver', { run: this.run });
      });
    }

    /* ───────────── 중국어 조각 ───────────── */
    nextDropChar() {
      if (!this.dropQueue.length) return null;
      const ch = this.dropQueue[this.dropIndex % this.dropQueue.length];
      this.dropIndex++;
      return ch;
    }

    spawnFragment(x, y) {
      if (this.dead) return;
      const ch = this.nextDropChar();
      if (!ch) return;
      ({ x, y } = this.freeSpot(x, y));
      const f = this.frags.create(x, y, 'token');
      f.setDepth(15);
      f.body.setSize(12, 12);
      f.body.setVelocity(Phaser.Math.Between(-40, 40), -150);
      f.body.setBounce(0.35);
      f.body.setDragX(90);
      f.setCollideWorldBounds(true);
      f.isFrag = true; f.ch = ch; f.bornAt = this.time.now; f.collected = false;
      f.label = DT.text(this, x, y, ch.h, { font: 'zh', size: 9, color: '#1a1c2c', stroke: null, depth: 16 });
      this.ring(x, y, 0xffcd75, 0.6);
      if (this.cleared) this.time.delayedCall(250, () => this.onCollect(this.player, f));
    }

    // 블록(#) 안이면 가장 가까운 빈칸(위쪽 우선, 다음 옆쪽)으로 옮김 — 조각이 못 가는 곳에 갇히지 않게
    /* ── 숨은 보물상자: 구체를 밟고 올라가야 닿는 받침대 위. 열면 꽝 또는 보물 ── */
    buildChests() {
      (this.chestSpots || []).forEach(c => {
        const ch = this.physics.add.staticImage(c.x, c.y - 8, 'chest', 0).setDepth(4);
        ch.body.setSize(16, 14);
        this.tweens.add({ targets: ch, y: ch.y - 1, yoyo: true, repeat: -1, duration: 500 });
        ch.glow = this.time.addEvent({ delay: 500, loop: true, callback: () => ch.active && !ch.opened && this.fxStar.explode(1, ch.x + Phaser.Math.Between(-8, 8), ch.y - 8) });
        this.physics.add.overlap(this.player, ch, () => this.openChest(ch));
      });
    }
    openChest(ch) {
      if (ch.opened || this.dead) return;
      ch.opened = true; ch.glow.remove();
      this.tweens.killTweensOf(ch);
      // 결과는 미리 정해 두고, 덜컹덜컹 흔들린 뒤에 공개
      const r = Math.random();
      const kind = r < 0.35 ? 'dud' : r < 0.62 ? 'score' : r < 0.77 ? 'heart' : r < 0.9 ? 'power' : 'gold';
      const x = ch.x, y0 = ch.y;
      DT.Audio.sfx('rattle');
      this.tweens.add({ targets: ch, angle: { from: -10, to: 10 }, yoyo: true, repeat: 4, duration: 55, onComplete: () => { ch.setAngle(0); reveal(); } });
      const reveal = () => {
        if (kind === 'dud') {
          // 꽝: 끼이익 천천히 열리고, 먼지 폴폴, 상자가 털썩 주저앉음
          ch.setFrame(1);
          DT.Audio.sfx('dud');
          this.fxDust.explode(10, x, y0 - 6);
          const puff = this.add.sprite(x, y0 - 10, 'puff', 0).setDepth(16).setTint(0x94b0c2).setScale(1.2);
          puff.play('fx_puff'); puff.once('animationcomplete', () => puff.destroy());
          this.tweens.add({ targets: ch, scaleY: 0.8, scaleX: 1.1, y: y0 + 2, duration: 260, ease: 'Quad.easeOut' });
          this.tweens.add({ targets: ch, alpha: 0.6, delay: 900, duration: 600 });
          const sad = DT.text(this, DT.clamp(x, 40, DT.W - 40), y0 - 22, '꽝… ㅠㅠ', { font: 'ko', size: 10, color: '#94b0c2', strokeThickness: 2, depth: 44 });
          this.tweens.add({ targets: sad, y: sad.y - 6, angle: { from: -4, to: 4 }, yoyo: true, repeat: 2, duration: 300 });
          this.tweens.add({ targets: sad, alpha: 0, delay: 1700, duration: 400, onComplete: () => sad.destroy() });
          this.addScore(100);
          return;
        }
        // 보물: 뚜껑이 팡! 빛기둥 + 보물이 둥실 떠오르며 반짝
        ch.setFrame(1);
        this.tweens.add({ targets: ch, scaleY: 1.25, yoyo: true, duration: 90 });
        const big = kind === 'gold';
        DT.Audio.sfx('treasure', big);
        const beam = this.add.rectangle(x, y0 - 6, big ? 22 : 14, 4, 0xfff3b0, 0.75).setOrigin(0.5, 1).setDepth(14).setBlendMode(Phaser.BlendModes.ADD);
        this.tweens.add({ targets: beam, height: big ? 140 : 90, duration: 260, ease: 'Cubic.easeOut' });
        this.tweens.add({ targets: beam, alpha: 0, delay: 700, duration: 500, onComplete: () => beam.destroy() });
        const ICON = { score: ['coin', 1.8, 0xffffff], heart: ['heart', 2, 0xffffff], power: ['star', 2.6, 0xa7f070], gold: ['coin', 2.8, 0xffffff] }[kind];
        const item = this.add.image(x, y0 - 8, ICON[0], 0).setScale(0.3).setDepth(45).setTint(ICON[2]);
        const tx = DT.clamp(x, 40, DT.W - 40);   // 벽 옆 상자여도 화면 안쪽으로 떠오름
        this.tweens.add({ targets: item, x: tx, y: y0 - 40, scale: ICON[1], duration: 420, ease: 'Back.easeOut' });
        this.tweens.add({ targets: item, angle: 360, duration: 700 });
        this.time.delayedCall(450, () => this.fxStar.explode(big ? 30 : 14, tx, y0 - 40));
        this.tweens.add({ targets: item, alpha: 0, scale: ICON[1] * 1.4, delay: 1300, duration: 300, onComplete: () => item.destroy() });
        this.ring(x, y0 - 10, 0xffcd75, big ? 2 : 1.4);
        DT.FX.play(this, 'collect', x, y0, { depth: 34 });
        let txt, col = 0xffcd75;
        if (kind === 'score') { txt = '보물! +5000'; this.addScore(5000); }
        else if (kind === 'heart') { if (this.hp < this.S.maxHp) { this.hp++; txt = '하트 보물! 체력 +1'; } else { this.addScore(3000); txt = '하트 보물! +3000'; } col = 0xff9db5; }
        else if (kind === 'power') { this.powerUntil = this.time.now + 10000; txt = '힘의 보물! 10초 강화'; col = 0xa7f070; }
        else { txt = '+15000'; this.addScore(15000); this.banner('황금 보물!!', 0xffcd75, 2.4, 1300); for (let i = 0; i < 4; i++) this.time.delayedCall(200 + i * 160, () => this.fxStar.explode(10, x + Phaser.Math.Between(-30, 30), y0 - Phaser.Math.Between(20, 60))); }
        this.time.delayedCall(380, () => this.popText(DT.clamp(x, 70, DT.W - 70), y0 - 58, txt, col, 1, 1700));
      };
    }
    checkChestHint() {
      if (this.chestHint || !this.chestSpots || !this.started) return;
      const p = this.player;
      if (this.chestSpots.some(c => Math.abs(c.x - p.x) < 70 && Math.abs(c.y - p.y) < 90)) {
        this.chestHint = true;
        this.hintText('높은 곳에 보물상자! 구체를 받침대 옆에 밀어 두고 밟고 올라가 봐요');
      }
    }
    // 바닥 구멍으로 떨어진 것들을 맨 위로
    wrapAround() {
      const H = this.mapH, move = (o) => {
        if (!o || !o.active || !o.body || o.y < H + 6) return;
        const vx = o.body.velocity.x, vy = o.body.velocity.y;
        o.body.reset(o.x, o.y - H - 16); o.body.setVelocity(vx, Math.min(vy, 200));
      };
      if (!this.dead) move(this.player);
      this.enemies.getChildren().forEach(e => { if (e.state !== 'dead') move(e); });
      [this.frags, this.poops, this.waves].forEach(g => g.getChildren().forEach(move));
    }

    // 네잎클로버: 하트 아이템 (먹으면 체력 +1)
    spawnHeart(x, y) {
      if (this.dead || this.cleared) return;
      ({ x, y } = this.freeSpot(x, y));
      const h = this.physics.add.image(x, y, 'heart').setDepth(15).setScale(1.4);
      h.body.setVelocity(Phaser.Math.Between(-30, 30), -160); h.body.setBounce(0.3); h.setCollideWorldBounds(true);
      this.physics.add.collider(h, this.terrain);
      this.physics.add.overlap(this.player, h, () => {
        if (!h.active) return;
        if (this.hp < this.S.maxHp) { this.hp++; this.popText(h.x, h.y - 10, '체력 +1', 0xff9db5); } else { this.addScore(500); this.popText(h.x, h.y - 10, '+500', 0xff9db5); }
        DT.Audio.sfx('collect'); h.destroy();
      });
      this.tweens.add({ targets: h, alpha: 0.3, delay: 6000, duration: 120, yoyo: true, repeat: 8, onComplete: () => h.active && h.destroy() });
    }
    // 두 점 사이(같은 높이)에 단단한 블록(#)이나 바깥 벽이 있는지
    wallBetween(x0, x1, y) {
      if (x1 < 2 || x1 > DT.W - 2) return true;
      const step = x1 > x0 ? 4 : -4;
      for (let x = x0; step > 0 ? x <= x1 : x >= x1; x += step) if (this.solidAt(x, y)) return true;
      return this.solidAt(x1, y);
    }
    solidAt(x, y) {
      const m = this.stage.map, r = Math.floor(y / 16), c = Math.floor(x / 16);
      return !!(m[r] && m[r][c] === '#');
    }
    freeSpot(x, y) {
      const inside = (px, py) => this.solidAt(px - 6, py - 6) || this.solidAt(px + 6, py - 6) || this.solidAt(px - 6, py + 6) || this.solidAt(px + 6, py + 6);
      if (!inside(x, y)) return { x, y };
      const cx = Math.floor(x / 16) * 16 + 8, cy = Math.floor(y / 16) * 16 + 8;
      for (let d = 1; d < 8; d++) {
        const cand = [[cx, cy - d * 16], [cx - d * 16, cy], [cx + d * 16, cy], [cx - d * 16, cy - d * 16], [cx + d * 16, cy - d * 16]];
        for (const [qx, qy] of cand) if (qx > 20 && qx < DT.W - 20 && qy > 20 && qy < this.mapH - 8 && !inside(qx, qy)) return { x: qx, y: qy };
      }
      return { x, y };
    }

    updateFrags(time) {
      this.frags.getChildren().slice().forEach(f => {
        if (!f.active) return;
        if (this.solidAt(f.x, f.y)) {   // 움직이는 발판 등에 밀려 블록 속에 들어가면 빼냄
          const q = this.freeSpot(f.x, f.y); f.body.reset(q.x, q.y); f.body.setVelocity(0, -60);
        }
        if (f.label) f.label.setPosition(Math.round(f.x), Math.round(f.y + 1));
        if (this.S.magnet && !this.dead) {
          const dx = this.player.x - f.x, dy = this.player.y - f.y, d = Math.hypot(dx, dy);
          if (d < this.S.magnet) { f.body.setVelocity(dx / d * 160, dy / d * 160); f.body.setAllowGravity(false); }
          else f.body.setAllowGravity(true);
        }
        const age = time - f.bornAt;
        if (age > 7000 + this.S.fragLife) {
          const vis = Math.floor(time / 100) % 2 === 0;
          f.setVisible(vis); if (f.label) f.label.setVisible(vis);
        }
        if (age > 9500 + this.S.fragLife) { if (f.label) f.label.destroy(); f.destroy(); }
      });
    }

    onCollect(a, b) {
      const f = a && a.isFrag ? a : b;
      if (!f || !f.isFrag || !f.active || f.collected || this.dead) return;
      f.collected = true;
      this.inventory.push(f.ch);
      this.addScore(50);
      DT.Audio.sfx('collect');
      // 글자 + 병음 표시
      const lab = f.label; f.label = null;
      if (lab) this.tweens.add({ targets: lab, x: 270, y: 12, scale: 0.6, alpha: 0, duration: 450, ease: 'Cubic.easeIn', onComplete: () => lab.destroy() });
      const py = DT.text(this, f.x, f.y - 12, f.ch.h + ' ' + f.ch.p, { font: 'zh', size: 9, color: '#ffcd75', depth: 46 });
      this.tweens.add({ targets: py, y: py.y - 14, alpha: 0, delay: 500, duration: 500, onComplete: () => py.destroy() });
      this.fxStar.explode(4, f.x, f.y);
      f.destroy();
      this.checkChunks();
      this.refreshInventory();
    }

    onEnemyFrag(a, b) {
      const f = a.isFrag ? a : b, e = a.isFrag ? b : a;
      if (e.kind !== 'thief' || e.state !== 'active' || !f.active || f.collected) return;
      f.collected = true;
      this.popText(f.x, f.y - 8, 'STOLEN!', 0xef7d57);
      this.emote(e, '!');
      DT.Audio.sfx('steal');
      if (f.label) f.label.destroy();
      f.destroy();
    }

    checkChunks() {
      (this.stage.chunks || []).forEach(id => {
        if (this.completed.has(id)) return;
        const v = DT.DATA.vocabById[id];
        if (!v) return;
        const used = [];
        for (const c of v.chars) {
          const i = this.inventory.findIndex((x, j) => x.h === c.h && used.indexOf(j) < 0);
          if (i < 0) return;
          used.push(i);
        }
        this.inventory = this.inventory.filter((_, j) => used.indexOf(j) < 0);
        this.completed.add(id);
        if (this.learned.indexOf(id) < 0) this.learned.push(id);
        this.onChunk(v);
      });
    }

    onChunk(v) {
      let reward = '';
      if (v.reward === 'heal') {
        if (this.hp < this.S.maxHp) { this.hp++; reward = '체력 +1'; } else { this.addScore(1000); reward = '체력 MAX! +1000'; }
      } else if (v.reward === 'power') {
        this.powerUntil = this.time.now + 8000; reward = ({ tuk: '씨앗탄', pong: '물방울탄', doto: '도토리탄' }[this.hero] || '씨앗탄') + ' 강화! (8초)';
      } else { this.addScore(2000); reward = '점수 +2000'; }
      DT.Audio.sfx('chunk');
      this.time.delayedCall(250, () => DT.Audio.speak(v.hanzi));

      // 게임을 가리지 않게: HUD 바로 아래 얇은 한 줄 알림이 오른쪽에서 스르륵 → 잠깐 뒤 사라짐
      const y = 21, w = 236, x0 = 160 - w / 2;
      const strip = this.add.rectangle(x0, y, w, 15, DT.C.ink, 0.72).setOrigin(0).setDepth(55);
      const line = this.add.rectangle(x0, y + 14, w, 1, DT.C.yellow, 0.9).setOrigin(0).setDepth(55);
      const t1 = DT.text(this, x0 + 6, y + 7, v.hanzi, { font: 'zh', size: 11, color: '#a7f070', strokeThickness: 2, ox: 0, depth: 56 });
      const t2 = DT.text(this, x0 + 8 + t1.width, y + 7, v.pinyin + ' · ' + v.meaning, { font: 'ko', size: 8, color: '#f4f4f4', stroke: null, ox: 0, depth: 56 });
      const t3 = DT.text(this, x0 + w - 6, y + 7, reward, { font: 'ko', size: 8, color: '#ffcd75', stroke: null, ox: 1, depth: 56 });
      const all = [strip, line, t1, t2, t3];
      this.ui.add(all);
      all.forEach(o => { o.setAlpha(0); o.x += 30; });
      this.tweens.add({ targets: all, alpha: 1, x: '-=30', duration: 220, ease: 'Cubic.easeOut' });
      this.tweens.add({ targets: all, alpha: 0, delay: 1900, duration: 300, onComplete: () => all.forEach(o => o.destroy()) });
      this.fxStar.explode(12, this.player.x, this.player.y);
      DT.FX.play(this, 'collect', this.player.x, this.player.y + 10, { depth: 34 });
    }

    /* ───────────── HUD ───────────── */
    buildHud() {
      const n0 = this.children.list.length;
      this.buildHudInner();
      this.ui.add(this.children.list.slice(n0).filter(o => o !== this.ui));
    }

    buildHudInner() {
      this.add.rectangle(0, 0, DT.W, 18, DT.C.ink, 0.82).setOrigin(0).setDepth(40);
      this.add.rectangle(0, 18, DT.W, 1, DT.C.teal, 1).setOrigin(0).setDepth(40);
      DT.ptext(this, 4, 1, '1P', { tint: 0xef7d57, depth: 41 });
      this.hudScore = DT.ptext(this, 20, 1, '0000000', { tint: 0xf4f4f4, depth: 41 });
      DT.ptext(this, 92, 1, 'HI', { tint: 0xef7d57, depth: 41 });
      this.hudHi = DT.ptext(this, 108, 1, '0000000', { tint: 0xffcd75, depth: 41 });
      DT.ptext(this, 284, 1, this.stage.id, { ox: 1, tint: 0x73eff7, depth: 41 });
      this.hearts = [];
      for (let i = 0; i < T.MAX_HP_CAP; i++) this.hearts.push(this.add.image(4 + i * 9, 10, 'heart').setOrigin(0).setDepth(41));
      this.shieldIcons = [];
      for (let i = 0; i < 2; i++) this.shieldIcons.push(this.add.image(4 + (T.MAX_HP_CAP + i) * 9 + 2, 10, 'leaf').setOrigin(0).setDepth(41).setVisible(false));
      this.refreshShield();
      this.hudCombo = DT.ptext(this, 112, 10, '', { tint: 0xef7d57, depth: 41 });
      DT.text(this, 200, 14, '조각', { font: 'ko', size: 7, color: '#94b0c2', stroke: null, ox: 1, depth: 41 });
      this.invSlots = [];
      for (let i = 0; i < 7; i++) {
        this.invSlots.push(DT.text(this, 208 + i * 11, 14, '', { font: 'zh', size: 8, color: '#ffcd75', strokeThickness: 2, depth: 41 }));
      }
    }

    refreshShield() {
      if (this.shieldIcons) this.shieldIcons.forEach((im, i) => im.setVisible(i < this.shieldLeft));
    }
    refreshInventory() {
      this.invSlots.forEach((s, i) => s.setText(this.inventory[i] ? this.inventory[i].h : ''));
    }

    updateHud(time) {
      const c = this.hudCache;
      if (c.score !== this.score) {
        c.score = this.score;
        this.hudScore.setText(DT.pad(this.score, 7));
        const hi = Math.max(this.score, DT.getHi());
        this.hudHi.setText(DT.pad(hi, 7));
      }
      if (c.hp !== this.hp) {
        c.hp = this.hp;
        this.hearts.forEach((h, i) => h.setVisible(i < this.S.maxHp).setTexture(i < this.hp ? 'heart' : 'heartEmpty'));
      }
      const combo = time < this.chainUntil && this.chainCombo >= 2 ? this.chainCombo : 0;
      if (c.combo !== combo) { c.combo = combo; this.hudCombo.setText(combo ? 'COMBO ×' + combo : ''); }
      if (time < this.powerUntil) this.hudCombo.setText('POWER ' + Math.ceil((this.powerUntil - time) / 1000) + (combo ? '  ×' + combo : ''));
      else if (c.powerShown) this.hudCombo.setText(combo ? 'COMBO ×' + combo : '');
      c.powerShown = time < this.powerUntil;
    }

    addScore(n) { this.score += n; }

    /* ───────────── 진행 ───────────── */
    readySequence() {
      const title = DT.ptext(this, 160, 96, 'STAGE ' + this.stage.id, { ox: 0.5, oy: 0.5, tint: 0x73eff7, scale: 2, depth: 60 });
      const name = DT.text(this, 160, 114, this.stage.name || '', { font: 'ko', size: 12, color: '#ffcd75', strokeThickness: 3, depth: 60 });
      const ready = DT.ptext(this, 160, 134, this.climb ? 'CLIMB TO THE FLAG!' : 'READY?', { ox: 0.5, oy: 0.5, tint: 0xf4f4f4, scale: 1, depth: 60 });
      this.ui.add([title, name, ready]);
      this.time.delayedCall(1500, () => {
        title.destroy(); name.destroy(); ready.destroy();
        this.banner('GO!', 0xa7f070, 3, 400);
        DT.Audio.sfx('go');
        this.enemies.getChildren().forEach(e => { if (e.state === 'spawn') { e.state = 'active'; e.setAlpha(1); } });
        this.started = true; this.fireLocked = false;
        if (this.boss) this.boss.state = 'active';
        if (this.climb) this.hintText(this.hazardName + '이(가) 올라와요! 문제 관문에서 틀리면 더 빨라져요!');
        this.stageStartAt = this.time.now;
      });
    }

    aliveCount() { return this.enemies.getChildren().filter(e => e.state !== 'dead').length; }

    stageClear() {
      this.cleared = true; this.fireLocked = true;
      const clearTime = this.time.now - this.stageStartAt;
      const D = this.boss ? 1800 : 0;
      this.time.delayedCall(500 + D, () => {
        this.frags.getChildren().slice().forEach((f, i) => this.time.delayedCall(i * 120, () => this.onCollect(this.player, f)));
      });
      this.time.delayedCall(1500 + D, () => {
        DT.Audio.music(false);
        DT.Audio.sfx('clear');
        this.controlLocked = true; this.winPose = true;
        this.player.body.setVelocityX(0);
        this.banner('STAGE CLEAR!', 0xffcd75, 2.5, 1800);
        if (clearTime < 60000) {
          const bonus = clearTime < 35000 ? 3000 : 1000;
          this.time.delayedCall(500, () => { this.popText(160, 140, 'TIME BONUS +' + bonus, 0xa7f070, 1, 1500); this.addScore(bonus); });
        }
      });
      this.time.delayedCall(3700 + D, () => this.openQuiz());
    }

    openQuiz() {
      if (this.dead) return;
      DT.saveHi(this.score);
      const q = DT.makeQuiz(this.stage);
      if (!q) { this.goNext(0); return; }
      this.scene.pause();
      this.scene.launch('Quiz', { question: q, stageId: this.stage.id });
    }

    // 퀴즈 결과를 받아 다음 스테이지 데이터 계산
    // 퀴즈 결과 → 파워업 선택 → 다음 스테이지 (마지막이면 엔딩)
    nextStageData(bonus, firstTry) {
      const run = this.run;
      run.score = this.score + (bonus || 0);
      run.hp = this.hp; run.learned = this.learned; run.maxCombo = this.maxCombo;
      DT.saveHi(run.score);
      if (this.stageIndex + 1 < DT.DATA.stages.length) {
        run.stage = this.stageIndex + 1;
        return { key: 'Upgrade', data: { run, picks: 1, extra: !!firstTry } };   // 한 번에 정답 → 카드 4장 중 1장
      }
      return { key: 'Ending', data: { run } };
    }

    goNext(bonus) {
      const n = this.nextStageData(bonus);
      this.scene.start(n.key, n.data);
    }

    togglePause() {
      this.isPaused = !this.isPaused;
      if (this.isPaused) {
        this.physics.world.pause(); this.tweens.pauseAll(); this.anims.pauseAll(); this.time.paused = true;
        this.pauseBox = DT.panel(this, 110, 96, 100, 40, { depth: 70 });
        this.pauseText = DT.ptext(this, 160, 104, 'PAUSE', { ox: 0.5, tint: 0xffcd75, scale: 2, depth: 71 });
        this.ui.add([this.pauseBox, this.pauseText]);
        DT.Audio.music(false);
      } else {
        this.physics.world.resume(); this.tweens.resumeAll(); this.anims.resumeAll(); this.time.paused = false;
        if (this.pauseBox) { this.pauseBox.destroy(); this.pauseText.destroy(); }
        DT.Audio.music(true, this.musicSpec);
      }
    }

    update(time) {
      DT.Input.update();
      if (DT.Input.justDown('pause') && this.started && !this.cleared && !this.dead) this.togglePause();
      if (this.isPaused) return;
      time = this.time.now;
      if (this.climbQuiz) { if (!this.climbQuiz.answered) this.updateClimbQuiz(time); this.syncScreenLayer(); return; }

      this.applySlopes();
      if (this.wrap) this.wrapAround();
      this.checkChestHint();
      this.updatePlayer(time);
      this.enemies.getChildren().slice().forEach(e => this.updateEnemy(e, time));
      this.seeds.getChildren().slice().forEach(s => {
        if (!s.active) return;
        if (s.mode === 'roll') s.body.setVelocityX(s.dir * s.speed);
        if (s.mode && s.mode !== 'arc' && Math.abs(s.x - s.startX) > s.range) { this.fxLeaf.explode(2, s.x, s.y); s.destroy(); return; }
        if (s.mode === 'line') s.setAlpha(1 - Math.max(0, Math.abs(s.x - s.startX) / s.range - 0.7) * 2);
        if (time - s.bornAt > T.SEED_LIFE * (s.mode === 'roll' ? 1.6 : 1) || s.x < -10 || s.x > DT.W + 10 || s.y > this.mapH + 10) s.destroy();
      });
      this.waves.getChildren().slice().forEach(w => this.updateWave(w, time));
      this.updateFrags(time);
      this.updateBoss(time);
      this.updateShots(time);
      if (this.climb) this.updateClimb(time, this.game.loop.delta);
      else this.syncScreenLayer();

      if (this.started && !this.cleared && !this.dead) {
        if (this.hudTime && !this.climb && !this.hurry) {
          const sec = Math.max(0, Math.ceil((this.hurryTime - (time - this.stageStartAt)) / 1000));
          if (sec !== this.lastSec) {
            this.lastSec = sec;
            this.hudTime.setText('TIME ' + DT.pad(sec, 2)).setTint(sec <= 10 ? 0xb13e53 : 0xffcd75);
            if (sec <= 5 && sec > 0) DT.Audio.sfx('tick');
          }
        }
        if (!this.hurry && !this.boss && !this.climb && time - this.stageStartAt > this.hurryTime) {
          this.hurry = true;
          if (this.hudTime) this.hudTime.setText('HURRY!').setTint(0xb13e53);
          this.banner('HURRY UP!', 0xb13e53, 2.5, 1200);
          DT.Audio.setTempo(1.15);
          DT.Audio.sfx('hurry');
          this.enemies.getChildren().forEach(e => { if (e.state === 'active') { e.angry = true; this.applyTint(e); } });
        }
        if (this.climb) { /* 골인으로만 클리어 */ }
        else if (this.boss ? this.boss.state === 'dead' : this.aliveCount() === 0) this.stageClear();
      }
      if (this.dead && this.player.y > this.mapH + 40) this.player.body.setVelocity(0, 0);
      this.updateHud(time);
    }
  }

  DT.GameScene = GameScene;
})();
