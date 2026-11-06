import * as THREE from 'three';
import {
  Assets,
  Engine,
  Intro,
  NavDebug,
  Physics,
  RAPIER,
  SettingsMenu,
  adoptStyle,
  applyOutlines,
  buildLevel,
  buildNav,
  configureI18n,
  configureSettings,
  configureUiRoot,
  getLang,
  installScreenshot,
  onLangChange,
  t,
  toonMaterial,
  uiContainer,
  type NavAgent,
} from '../../src';
import './strings';

/**
 * 기본 예제: 기본 도형만으로 만든 작은 장면.
 *   - 바닥과 장애물 몇 개 (코드로 만든 THREE.Group을 레벨 규칙으로 읽는다: buildLevel)
 *   - 실행 중에 굽는 내비메시 (buildNav, 워커)
 *   - 클릭한 자리로 내비 에이전트를 따라 걷는 캡슐 (Rapier 캐릭터 컨트롤러 + NavAgent 'steer')
 *   - 툰 셰이딩 + 외곽선 (toonMaterial, applyOutlines)
 *   - 닫힌 섀도 루트 UI와 일시정지·설정 메뉴 (Esc)
 *   - ko/en 다국어 (설정 메뉴의 언어)
 *   - 로고 인트로 (엔진 첫 카드만. ?nointro=1이면 생략)
 */

configureSettings({ storageKey: 'sce-example.settings' });
configureI18n({ storageKey: 'sce-example.lang', defaultLang: 'ko', languages: ['ko', 'en'] });
configureUiRoot({ hostId: 'game' });

adoptStyle(
  'example',
  `.demo-hud { position: absolute; left: 16px; top: 14px; padding: 10px 14px; max-width: 420px; border-left: 3px solid var(--ui-accent);
     background: var(--ui-panel); border-radius: 0 8px 8px 0; pointer-events: none; text-shadow: 0 1px 2px #000; }
   .demo-hud b { display: block; font-size: 15px; letter-spacing: 0.04em; margin-bottom: 4px; }
   .demo-hud p { margin: 2px 0; font-size: 13px; opacity: 0.9; }
   .demo-hud small { display: block; margin-top: 6px; font: 600 11px var(--ui-mono); opacity: 0.7; }`,
);

declare global {
  interface Window {
    /** 점검용 (scripts/examplecheck.mjs) */
    __demo?: {
      ready: boolean;
      character: () => { x: number; y: number; z: number };
      agent: () => string;
      clickWorld: (x: number, z: number) => { x: number; y: number } | null;
      navStats: () => unknown;
    };
  }
}

const RADIUS = 0.3;
const HALF = 0.5;
const SPAWN = new THREE.Vector3(-6, 0, 6);

async function main(): Promise<void> {
  const container = uiContainer();
  // 인트로는 장면을 만드는 동안 위에 덮여 돈다 (레이어 그림은 준비 단계에서 미리 그린다)
  if (new URLSearchParams(location.search).get('nointro') !== '1') void new Intro(container).play();
  const engine = new Engine(container, { clearColor: 0xf6dfe6 });
  installScreenshot(engine, { prefix: 'strawberry-cake' });
  const physics = await Physics.create();
  const assets = new Assets();

  // ---------------------------------------------------------------- 장면 (기본 도형)
  const root = new THREE.Group();
  root.name = 'demo_level';
  // 레벨 환경 (레벨 루트 커스텀 속성과 같은 규칙: level/Level.ts readEnv)
  root.userData = { sky: '#f6dfe6', fog: '45,140', sun: '-0.6,1,0.5', ambient: 1.6, sunIntensity: 2.2 };

  const box = (name: string, size: [number, number, number], pos: [number, number, number], color: number, rotY = 0) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...size), toonMaterial(color));
    m.name = name;
    m.position.set(...pos);
    m.rotation.y = rotY;
    root.add(m);
    return m;
  };
  box('ground', [40, 1, 40], [0, -0.5, 0], 0xf3e9d8);
  box('crate_a', [2, 1.4, 2], [-2, 0.7, 1], 0xd98a6a, 0.3);
  box('crate_b', [1.4, 1, 1.4], [3, 0.5, -2], 0xc66d8d);
  box('wall', [9, 2.2, 0.6], [1, 1.1, -6], 0xb9a7d6);
  box('wall_b', [0.6, 2.2, 7], [-5.5, 1.1, -3], 0xb9a7d6);
  box('platform', [5, 1, 5], [8, 0.5, 4], 0x9ccfc0);
  // 경사로: 바닥에서 단 위로 (캡슐도 내비 에이전트도 걸어 오른다)
  const ramp = box('ramp', [4.2, 0.3, 2.4], [4.2, 0.45, 4], 0x9ccfc0);
  ramp.rotation.z = Math.atan2(1, 4);

  // 툰 셰이딩 기본 도형: 받침대 위에서 도는 매듭 (spin 속성: 레벨이 돌린다)
  const pedestal = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.1, 1, 32), toonMaterial(0xe8d2b8));
  pedestal.name = 'pedestal';
  pedestal.position.set(-1, 0.5, -10);
  root.add(pedestal);
  const knot = new THREE.Mesh(new THREE.TorusKnotGeometry(0.7, 0.24, 160, 24), toonMaterial(0xf19bb0));
  knot.name = 'toon_knot';
  knot.position.set(-1, 2.2, -10);
  knot.userData = { collider: 0, spin: '0,40,0' };
  root.add(knot);

  // 시작 자리 마커 (SPAWN_): 내비 굽기의 씨앗. 이어지지 않은 섬(상자 윗면 등)을 뺀다
  const spawn = new THREE.Object3D();
  spawn.name = 'SPAWN_start';
  spawn.position.copy(SPAWN);
  root.add(spawn);

  applyOutlines(root);
  const level = await buildLevel({ engine, physics, assets }, root, { id: 'demo', path: 'code:demo' });
  level.attach(engine);
  engine.add(level);

  // ---------------------------------------------------------------- 캡슐 캐릭터 (Rapier 캐릭터 컨트롤러)
  const world = physics.world;
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(SPAWN.x, SPAWN.y + HALF + RADIUS + 0.05, SPAWN.z));
  const collider = world.createCollider(RAPIER.ColliderDesc.capsule(HALF, RADIUS), body);
  const kcc = world.createCharacterController(0.02);
  kcc.setUp({ x: 0, y: 1, z: 0 });
  kcc.setMaxSlopeClimbAngle((50 * Math.PI) / 180);
  kcc.enableAutostep(0.3, 0.2, false);
  kcc.enableSnapToGround(0.3);
  const capsule = new THREE.Group();
  const capsuleMesh = new THREE.Mesh(new THREE.CapsuleGeometry(RADIUS, HALF * 2, 8, 20), toonMaterial(0xff7f9f));
  const nose = new THREE.Mesh(new THREE.SphereGeometry(0.09, 16, 12), toonMaterial(0xfff4e6));
  nose.position.set(0, 0.35, -RADIUS);
  capsule.add(capsuleMesh, nose);
  applyOutlines(capsule);
  engine.world.add(capsule);
  let vy = 0;
  let yaw = 0;

  // 목표 표시
  const marker = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.4, 32), new THREE.MeshBasicMaterial({ color: 0xff5f87, transparent: true, opacity: 0.85 }));
  marker.rotation.x = -Math.PI / 2;
  marker.visible = false;
  engine.world.add(marker);

  // ---------------------------------------------------------------- UI (닫힌 섀도 루트 안)
  const hud = document.createElement('div');
  hud.className = 'demo-hud';
  container.appendChild(hud);
  let agent: NavAgent | null = null;
  const renderHud = () => {
    const state = agent ? t(`demo.state.${agent.state}`) : t('demo.baking');
    hud.innerHTML = `<b>${t('demo.title')}</b><p>${t('demo.hint')}</p><p>${t('demo.state', { state })}</p><small>${t('demo.keys')} · ${getLang().toUpperCase()}</small>`;
  };
  renderHud();
  onLangChange(renderHud);

  const navDebug = new NavDebug();
  navDebug.visible = false;
  engine.world.add(navDebug.root);

  const menu = new SettingsMenu(
    container,
    engine,
    {
      resume: () => (engine.paused = false),
      heading: () => 'strawberry-cake-engine',
      items: [{ id: 'navmesh', label: () => t('demo.menu.navmesh'), run: () => ((navDebug.visible = !navDebug.visible), (engine.paused = false)) }],
    },
    { settings: ['lang', 'fov', 'graphics'] },
  );
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape') {
      if (menu.isOpen) {
        menu.hide();
        engine.paused = false;
      } else {
        menu.show();
        engine.paused = true;
      }
    } else if (e.code === 'KeyN' && !menu.isOpen) navDebug.visible = !navDebug.visible;
  });

  // ---------------------------------------------------------------- 카메라 (캡슐을 비스듬히 내려다본다)
  const camTarget = new THREE.Vector3();
  const camOffset = new THREE.Vector3(0, 9, 11);
  engine.camera.position.copy(SPAWN).add(camOffset);
  engine.camera.lookAt(SPAWN);

  // ---------------------------------------------------------------- 고정 스텝: 내비 조향 → 캐릭터 컨트롤러 → 물리
  const foot = new THREE.Vector3();
  engine.add({
    fixedUpdate(dt) {
      const p = body.translation();
      foot.set(p.x, p.y - HALF - RADIUS, p.z);
      const v = agent ? agent.update(dt, foot) : new THREE.Vector3();
      kcc.computeColliderMovement(collider, { x: v.x * dt, y: vy * dt, z: v.z * dt });
      const m = kcc.computedMovement();
      vy = kcc.computedGrounded() ? -1 : Math.max(-30, vy - 9.81 * dt);
      body.setNextKinematicTranslation({ x: p.x + m.x, y: p.y + m.y, z: p.z + m.z });
      if (v.lengthSq() > 0.04) yaw = Math.atan2(-v.x, -v.z);
      physics.step();
    },
    update(dt) {
      const p = body.translation();
      capsule.position.set(p.x, p.y, p.z);
      capsule.rotation.y += (((yaw - capsule.rotation.y + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * Math.min(1, dt * 10);
      camTarget.set(p.x, p.y, p.z);
      const want = camTarget.clone().add(camOffset);
      engine.camera.position.lerp(want, Math.min(1, dt * 3));
      engine.camera.lookAt(camTarget);
      if (agent?.state === 'arrived' || agent?.state === 'failed') marker.visible = false;
      (marker.material as THREE.MeshBasicMaterial).opacity = 0.6 + 0.3 * Math.sin(performance.now() / 180);
      if (navDebug.visible) navDebug.update();
      renderHud();
    },
  });

  // ---------------------------------------------------------------- 클릭 → 보이는 형상 레이 → 에이전트 목표
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const clickAt = (clientX: number, clientY: number): THREE.Vector3 | null => {
    const r = engine.renderer.domElement.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, engine.camera);
    const hit = physics.visualRaycast(ray.ray.origin, ray.ray.direction, 300, { excludeCollider: collider });
    if (!hit || !agent) return null;
    agent.moveTo(hit.point);
    marker.position.copy(hit.point).addScaledVector(hit.normal, 0.03);
    marker.visible = true;
    return hit.point;
  };
  engine.renderer.domElement.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || menu.isOpen) return;
    clickAt(e.clientX, e.clientY);
  });

  engine.start();

  // ---------------------------------------------------------------- 내비메시 (실행 중에 굽는다)
  const nav = await buildNav(level, { radius: RADIUS, height: 1.6, climb: 0.3, cs: 0.15, traverse: false, dropLinks: false, workers: 2 });
  engine.add({ fixedUpdate: () => void nav.update() });
  navDebug.setNav(nav);
  agent = nav.createAgent(SPAWN, { mode: 'steer', speed: 3.2, radius: RADIUS, label: 'capsule', color: 0xff5f87 });

  window.__demo = {
    ready: true,
    character: () => {
      const p = body.translation();
      return { x: +p.x.toFixed(3), y: +p.y.toFixed(3), z: +p.z.toFixed(3) };
    },
    agent: () => agent?.state ?? 'none',
    /** 월드 (x, 0, z)를 화면 좌표로 (점검 스크립트가 그 자리를 진짜 마우스로 누른다) */
    clickWorld: (x, z) => {
      const v = new THREE.Vector3(x, 0, z).project(engine.camera);
      const r = engine.renderer.domElement.getBoundingClientRect();
      if (Math.abs(v.x) > 1 || Math.abs(v.y) > 1) return null;
      return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
    },
    navStats: () => nav.stats,
  };
}

main().catch((e) => {
  console.error(e);
  (window as unknown as { __error?: string }).__error = String((e as Error)?.stack ?? e);
});
