/* ============================================================
   SOLARIS · 主程序
   场景构建 / 交互 / 动画 / UI 联动
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     一、常量与状态
     ============================================================ */

  // 视觉时间基准：地球公转一圈约 9 秒
  const BASE_ORBIT_SPEED = (Math.PI * 2) / 9.0;
  // 自转基准：数值越大转得越快
  const BASE_SPIN_SPEED = 0.95;
  // 小行星带整体基准角速度
  const BASE_BELT_SPEED = 0.10;

  const SUN_TEXTURE_SIZE = [1024, 512];
  const PLANET_TEXTURE_SIZE = [1024, 512];
  const MOON_TEXTURE_SIZE = [512, 256];

  const state = {
    paused: false,
    timeScale: 1,
    showOrbits: true,
    bloomOn: true,
    hovered: null,
    focusRef: null,
    focusPhase: 'idle',   // idle | moving | locked
    booted: false
  };

  let renderer, scene, camera, controls, composer, bloomPass, clock;
  let starField, starFieldFar, beltMesh;
  let sunRef = null;

  const planets = [];          // 行星运行时对象
  const moonRefs = [];         // 所有卫星运行时对象
  const pickables = [];        // 可拾取目标
  const orbitLines = [];
  const beltData = [];

  // 复用的临时对象，避免在循环里频繁分配
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3();

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2(-10, -10);
  let pointerPx = { x: 0, y: 0 };

  const dom = {};

  /* ============================================================
     二、工具函数
     ============================================================ */

  /**
   * 让出主线程一帧，好让加载进度条能刷新出来。
   * 必须带定时器兜底：标签页处于后台时 rAF 不会触发，
   * 只等 rAF 的话整个加载流程会永久卡死。
   */
  function nextFrame() {
    return new Promise(resolve => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; resolve(); } };
      requestAnimationFrame(() => setTimeout(done, 0));
      setTimeout(done, 64);
    });
  }

  const easeInOutCubic = t =>
    t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

  /** 取一个运行时对象所代表天体的世界坐标 */
  function worldPosOf(ref, out) {
    return ref.anchor.getWorldPosition(out);
  }

  /** 该天体在画面里应该占据的观看距离 */
  function focusDistanceOf(ref) {
    const r = ref.data.radius;
    return Math.max(r * 5.0, 1.35);
  }

  /* ============================================================
     三、场景初始化
     ============================================================ */

  function initRenderer() {
    const canvas = document.getElementById('scene');

    renderer = new THREE.WebGLRenderer({
      canvas: canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.outputEncoding = THREE.sRGBEncoding;
    // 背景必须清成不透明：canvas 透明时，太阳辉光那点极低的 alpha 会被页面底色盖住，
    // 而在开启 bloom 后，bloom 的 copy pass 会把整个 readBuffer 的 alpha 写成 1，
    // 于是背景突然全部显形，看起来像"开 bloom 就多出一块方块"。
    renderer.setClearAlpha(1);

    TexGen.maxAnisotropy = renderer.capabilities.getMaxAnisotropy();

    scene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera(52, window.innerWidth / window.innerHeight, 0.1, 4000);
    camera.position.set(0, 55, 118);

    controls = new THREE.OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.055;
    controls.rotateSpeed = 0.5;
    controls.zoomSpeed = 0.85;
    controls.enablePan = false;
    controls.minDistance = 1.1;
    controls.maxDistance = 620;

    clock = new THREE.Clock();

    window.addEventListener('resize', onResize);
  }

  function initComposer() {
    // 注意：这里不要给 EffectComposer 传 HalfFloat 的渲染目标。
    // UnrealBloomPass 会逐级下采样读取该纹理，半浮点格式下会读出块状伪影。
    composer = new THREE.EffectComposer(renderer);
    composer.addPass(new THREE.RenderPass(scene, camera));

    bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.75,   // 强度：太高会把行星亮面直接推到纯白
      0.32,   // 扩散半径：压低可让权重集中在高分辨率的那级 mip，减少块状伪影
      0.72    // 亮度阈值：太阳叠了加法混合层后线性亮度约 0.79，行星亮面压在 0.6 以下，
              // 阈值落在这两者之间，才能只让恒星与最亮的星点溢出
    );
    composer.addPass(bloomPass);

    // EffectComposer 的中间结果处于线性空间，最后需要手动做一次 sRGB 编码
    composer.addPass(new THREE.ShaderPass(THREE.GammaCorrectionShader));
  }

  function initLights() {
    // 太阳光：distance 为 0 表示不做距离衰减，保证外行星也看得清。
    // 强度压在 0.85：行星亮面若被照到接近或超过太阳本体亮度，bloom 会把整颗
    // 星球推成纯白，看起来比恒星还亮。
    const sunLight = new THREE.PointLight(0xfff2dd, 0.85, 0, 0);
    sunLight.position.set(0, 0, 0);
    scene.add(sunLight);

    // 冷色调环境光，让行星暗面呈现一点星云般的蓝
    scene.add(new THREE.AmbientLight(0x2c3f5e, 0.75));
  }

  /* ============================================================
     四、星空背景
     ============================================================ */

  function createStarField() {
    const glowTex = TexGen.makeGlowTexture([255, 255, 255], 2.4);

    // 星点色温调色板：偏白、偏蓝、偏黄、偏橙
    const palette = [
      [255, 255, 255], [206, 226, 255], [170, 200, 255],
      [255, 244, 214], [255, 226, 186], [255, 208, 170]
    ];

    function buildStars(count, rMin, rMax, size, opacity, flatten) {
      const geo = new THREE.BufferGeometry();
      const pos = new Float32Array(count * 3);
      const col = new Float32Array(count * 3);

      for (let i = 0; i < count; i++) {
        // 球面均匀采样
        const u = Math.random() * 2 - 1;
        const theta = Math.random() * Math.PI * 2;
        const sq = Math.sqrt(1 - u * u);
        const r = rMin + Math.random() * (rMax - rMin);

        let x = sq * Math.cos(theta) * r;
        let y = u * r;
        let z = sq * Math.sin(theta) * r;

        if (flatten) y *= 0.55;   // 压扁一点，形成银河带的感觉

        pos[i * 3] = x; pos[i * 3 + 1] = y; pos[i * 3 + 2] = z;

        const c = palette[(Math.random() * palette.length) | 0];
        const b = 0.45 + Math.random() * 0.55;   // 亮度抖动
        col[i * 3] = (c[0] / 255) * b;
        col[i * 3 + 1] = (c[1] / 255) * b;
        col[i * 3 + 2] = (c[2] / 255) * b;
      }

      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

      const mat = new THREE.PointsMaterial({
        size: size,
        map: glowTex,
        vertexColors: true,
        transparent: true,
        opacity: opacity,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      });

      return new THREE.Points(geo, mat);
    }

    starField = buildStars(2600, 420, 900, 3.4, 0.95, false);
    starFieldFar = buildStars(4200, 900, 1700, 5.0, 0.75, true);

    scene.add(starField);
    scene.add(starFieldFar);
  }

  /* ============================================================
     五、太阳
     ============================================================ */

  function createSun() {
    const d = SOLAR_SYSTEM.sun;
    const anchor = new THREE.Object3D();
    scene.add(anchor);

    const geo = new THREE.SphereGeometry(d.radius, 64, 48);
    const mat = new THREE.MeshBasicMaterial({
      map: TexGen.getTexture(d.texture, SUN_TEXTURE_SIZE[0], SUN_TEXTURE_SIZE[1])
    });
    const mesh = new THREE.Mesh(geo, mat);
    anchor.add(mesh);

    // 再叠一层加法混合的同款球体。太阳纹理是偏暗的橙红，线性亮度只有 0.5 上下，
    // 比被点光照亮的金星亮面（接近 1.0）还低，bloom 的亮度阈值就无处落脚：
    // 调低会让所有行星亮面过曝成纯白，调高又提取不到太阳。叠一层把太阳推成
    // 画面里最亮的物体，阈值才能真正只挑出恒星。
    const boost = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
      map: mat.map,
      transparent: true,
      opacity: 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    }));
    boost.scale.setScalar(1.002);
    anchor.add(boost);

    // 三层叠加的辉光，由内到外逐渐扩散
    const glowLayers = [
      { scale: 3.4, color: [255, 198, 104], opacity: 0.95, power: 2.6 },
      { scale: 6.2, color: [255, 156, 62], opacity: 0.42, power: 2.2 },
      { scale: 8.6, color: [255, 122, 44], opacity: 0.17, power: 1.9 }
    ];

    const glows = glowLayers.map(cfg => {
      const tex = TexGen.makeGlowTexture(cfg.color, cfg.power);
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
        map: tex,
        transparent: true,
        opacity: cfg.opacity,
        blending: THREE.AdditiveBlending,
        depthWrite: false
      }));
      sprite.scale.setScalar(d.radius * cfg.scale);
      sprite.userData.baseOpacity = cfg.opacity;
      anchor.add(sprite);
      return sprite;
    });

    sunRef = {
      kind: 'sun',
      data: d,
      anchor: anchor,
      mesh: mesh,
      mat: mat,
      glows: glows,
      spin: 0.05
    };
    mesh.userData.ref = sunRef;
    pickables.push(mesh);

    // 拾取辅助球：让太阳更容易被点中
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(d.radius * 1.05, 16, 12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    hit.userData.ref = sunRef;
    anchor.add(hit);
    pickables.push(hit);
  }

  /* ============================================================
     六、行星
     ============================================================ */

  function createPlanet(data) {
    // 公转容器：绕 Y 轴旋转，代表行星在轨道上的位置
    const orbitContainer = new THREE.Object3D();
    scene.add(orbitContainer);

    // 锚点：位于轨道半径处，其世界坐标即行星中心
    const anchor = new THREE.Object3D();
    anchor.position.x = data.orbit;
    orbitContainer.add(anchor);

    // 倾角容器：让自转轴倾斜，环系与卫星跟随赤道面
    const tiltGroup = new THREE.Object3D();
    tiltGroup.rotation.z = data.tilt;
    anchor.add(tiltGroup);

    const geo = new THREE.SphereGeometry(data.radius, 64, 48);
    const mat = new THREE.MeshStandardMaterial({
      map: TexGen.getTexture(data.texture, PLANET_TEXTURE_SIZE[0], PLANET_TEXTURE_SIZE[1]),
      roughness: 0.88,
      metalness: 0.02
    });
    const mesh = new THREE.Mesh(geo, mat);
    tiltGroup.add(mesh);

    const ref = {
      kind: 'planet',
      data: data,
      orbitContainer: orbitContainer,
      anchor: anchor,
      tiltGroup: tiltGroup,
      mesh: mesh,
      mat: mat,
      clouds: null,
      ring: null,
      moons: [],
      angle: Math.random() * Math.PI * 2,
      spinAngle: Math.random() * Math.PI * 2
    };

    mesh.userData.ref = ref;
    pickables.push(mesh);

    // 拾取辅助球
    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(data.radius * 2.0, 0.95), 16, 12),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    hit.userData.ref = ref;
    anchor.add(hit);
    pickables.push(hit);

    // 地球云层
    if (data.clouds) {
      const cloudTex = TexGen.getTexture('earthClouds', PLANET_TEXTURE_SIZE[0], PLANET_TEXTURE_SIZE[1]);
      const cloudMat = new THREE.MeshStandardMaterial({
        map: cloudTex,
        transparent: true,
        depthWrite: false,
        roughness: 1.0,
        metalness: 0.0,
        opacity: 0.92
      });
      const cloudMesh = new THREE.Mesh(
        new THREE.SphereGeometry(data.radius * 1.017, 64, 48),
        cloudMat
      );
      tiltGroup.add(cloudMesh);
      ref.clouds = cloudMesh;
    }

    // 行星环
    if (data.ring) {
      ref.ring = createRing(data);
      // 天王星环几乎垂直于黄道面，随倾角容器一起转即可
      tiltGroup.add(ref.ring);
    }

    // 卫星
    if (data.moons) {
      data.moons.forEach((m, i) => {
        const moon = createMoon(m, data.radius, ref);
        ref.moons.push(moon);
        moonRefs.push(moon);
      });
    }

    planets.push(ref);
    return ref;
  }

  function createRing(data) {
    const inner = data.radius * data.ring.inner;
    const outer = data.radius * data.ring.outer;
    const segments = 160;

    const geo = new THREE.RingGeometry(inner, outer, segments, 2);

    // RingGeometry 默认的 UV 是平面投影，需要改写成"沿半径方向"的一维映射
    const posAttr = geo.attributes.position;
    const uvAttr = geo.attributes.uv;
    const v = new THREE.Vector3();
    for (let i = 0; i < posAttr.count; i++) {
      v.fromBufferAttribute(posAttr, i);
      const t = (v.length() - inner) / (outer - inner);
      uvAttr.setXY(i, t, 0.5);
    }
    uvAttr.needsUpdate = true;

    const tex = TexGen.makeRingTexture(!!data.ring.vertical);
    const mat = new THREE.MeshBasicMaterial({
      map: tex,
      transparent: true,
      opacity: data.ring.opacity,
      side: THREE.DoubleSide,
      depthWrite: false
    });

    const ring = new THREE.Mesh(geo, mat);
    ring.rotation.x = -Math.PI / 2;   // 躺平到赤道面
    return ring;
  }

  function createMoon(data, parentRadius, parentRef) {
    // 卫星轨道容器挂在行星锚点下（不跟随行星自转轴倾角）
    const pivot = new THREE.Object3D();
    parentRef.anchor.add(pivot);

    const anchor = new THREE.Object3D();
    anchor.position.x = parentRadius + data.dist;
    pivot.add(anchor);

    const geo = new THREE.SphereGeometry(data.radius, 32, 24);
    const mat = new THREE.MeshStandardMaterial({
      map: TexGen.getTexture(data.texture, MOON_TEXTURE_SIZE[0], MOON_TEXTURE_SIZE[1]),
      roughness: 0.95,
      metalness: 0.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    anchor.add(mesh);

    const ref = {
      kind: 'moon',
      data: {
        id: parentRef.data.id + '-' + data.name,
        name: data.name,
        en: data.name,
        type: '天然卫星',
        badge: parentRef.data.name + '的卫星',
        radius: data.radius,
        color: data.color,
        facts: [['母星', parentRef.data.name], ['轨道半径', parentRef.data.radius + ' + ' + data.dist]],
        desc: data.desc || (data.name + ' 是 ' + parentRef.data.name + ' 的天然卫星。'),
        highlights: []
      },
      parent: parentRef,
      pivot: pivot,
      anchor: anchor,
      mesh: mesh,
      mat: mat,
      angle: Math.random() * Math.PI * 2,
      speed: data.speed,
      spinAngle: 0
    };

    mesh.userData.ref = ref;
    pickables.push(mesh);

    const hit = new THREE.Mesh(
      new THREE.SphereGeometry(Math.max(data.radius * 2.4, 0.5), 12, 10),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
    );
    hit.userData.ref = ref;
    anchor.add(hit);
    pickables.push(hit);

    return ref;
  }

  /* ============================================================
     七、轨道线与小行星带
     ============================================================ */

  function createOrbitLine(radius, color, opacity) {
    const N = 256;
    const pts = [];
    for (let i = 0; i <= N; i++) {
      const a = (i / N) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * radius, 0, Math.sin(a) * radius));
    }
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = new THREE.LineBasicMaterial({
      color: color,
      transparent: true,
      opacity: opacity
    });
    return new THREE.Line(geo, mat);
  }

  function createOrbits() {
    planets.forEach(p => {
      const line = createOrbitLine(p.data.orbit, p.data.color, p.data.dwarf ? 0.16 : 0.28);
      scene.add(line);
      orbitLines.push(line);
    });
  }

  function createAsteroidBelt() {
    const cfg = ASTEROID_BELT;
    const count = cfg.count;

    // 用低面数的十二面体做碎石，flatShading 强化棱角
    const geo = new THREE.DodecahedronGeometry(0.055, 0);
    const mat = new THREE.MeshStandardMaterial({
      color: 0x9a8d7e,
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true
    });

    beltMesh = new THREE.InstancedMesh(geo, mat, count);
    beltMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

    for (let i = 0; i < count; i++) {
      const r = cfg.inner + Math.random() * (cfg.outer - cfg.inner);
      const d = {
        r: r,
        y: (Math.random() - 0.5) * cfg.thickness * (0.6 + Math.random() * 0.8),
        angle: Math.random() * Math.PI * 2,
        // 内圈转得快，外圈转得慢
        speed: BASE_BELT_SPEED * Math.pow(cfg.inner / r, 1.5),
        scale: 0.4 + Math.pow(Math.random(), 2.2) * 2.2,
        rx: Math.random() * Math.PI,
        ry: Math.random() * Math.PI,
        rz: Math.random() * Math.PI
      };
      beltData.push(d);
    }

    // 先按初始角度铺好，避免第一帧之前所有实例堆在原点
    applyBeltMatrices();

    scene.add(beltMesh);
  }

  function applyBeltMatrices() {
    if (!beltMesh) return;
    for (let i = 0; i < beltData.length; i++) {
      const d = beltData[i];
      _v1.set(Math.cos(d.angle) * d.r, d.y, Math.sin(d.angle) * d.r);
      _e.set(d.rx + d.angle * 0.6, d.ry + d.angle * 0.9, d.rz);
      _q.setFromEuler(_e);
      _s.setScalar(d.scale);
      _m4.compose(_v1, _q, _s);
      beltMesh.setMatrixAt(i, _m4);
    }
    beltMesh.instanceMatrix.needsUpdate = true;
  }

  /* ============================================================
     八、纹理预生成（带进度回调）
     ============================================================ */

  async function buildTextures(onProgress) {
    const jobs = [];

    jobs.push({ label: '恒星核心', key: SOLAR_SYSTEM.sun.texture, size: SUN_TEXTURE_SIZE });

    SOLAR_SYSTEM.planets.forEach(p => {
      jobs.push({ label: p.name + ' 地表', key: p.texture, size: PLANET_TEXTURE_SIZE });
      if (p.clouds) jobs.push({ label: p.name + ' 云层', key: 'earthClouds', size: PLANET_TEXTURE_SIZE });
      if (p.moons) {
        p.moons.forEach(m => jobs.push({ label: m.name + ' 地表', key: m.texture, size: MOON_TEXTURE_SIZE }));
      }
    });

    for (let i = 0; i < jobs.length; i++) {
      const job = jobs[i];
      onProgress(i / jobs.length, job.label);
      await nextFrame();
      TexGen.getTexture(job.key, job.size[0], job.size[1]);
    }

    onProgress(1, '完成');
  }

  /* ============================================================
     九、交互：悬停与拾取
     ============================================================ */

  function updatePointerFromEvent(e) {
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  function pickAtPointer() {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(pickables, false);
    return hits.length ? hits[0].object.userData.ref : null;
  }

  function setHovered(ref) {
    if (state.hovered === ref) return;

    // 还原上一个（太阳用的是 MeshBasicMaterial，没有 emissive）
    if (state.hovered && state.hovered.mat && state.hovered.mat.emissive) {
      state.hovered.mat.emissive.setHex(0x000000);
    }

    state.hovered = ref;

    if (ref && ref.mat && ref.mat.emissive) {
      // 微微自发光，配合 bloom 形成一圈淡淡的描边
      ref.mat.emissive.setHex(0x1d3d5c);
      dom.tooltip.textContent = ref.data.name + (ref.data.en && ref.data.en !== ref.data.name ? ' · ' + ref.data.en : '');
      dom.tooltip.classList.add('is-visible');
      dom.canvas.style.cursor = 'pointer';
    } else {
      dom.tooltip.classList.remove('is-visible');
      dom.canvas.style.cursor = 'grab';
    }
  }

  function moveTooltip() {
    if (!state.hovered) return;
    const x = pointerPx.x + 18;
    const y = pointerPx.y - 14;
    dom.tooltip.style.transform = 'translate(' + x + 'px,' + y + 'px)';
  }

  function onPointerMove(e) {
    updatePointerFromEvent(e);
    moveTooltip();
  }

  function onClick(e) {
    // 拖拽视角时不应触发选中
    if (dragMoved) return;

    const ref = pickAtPointer();
    if (ref) {
      openInfo(ref);
      focusOn(ref);
    } else {
      closeInfo();
      releaseFocus();
    }
  }

  /* ============================================================
     十、相机聚焦与跟随
     ============================================================ */

  const _prevFocusPos = new THREE.Vector3();

  function focusOn(ref) {
    state.focusRef = ref;
    state.focusPhase = 'moving';
    dom.follow.classList.add('is-active');
    dom.followName.textContent = ref.data.name;
  }

  function releaseFocus() {
    state.focusRef = null;
    state.focusPhase = 'idle';
    dom.follow.classList.remove('is-active');
  }

  function updateFocus(dt) {
    const ref = state.focusRef;
    if (!ref) return;

    worldPosOf(ref, _v1);   // _v1 = 天体当前世界坐标

    if (state.focusPhase === 'moving') {
      // 目标点平滑靠拢
      controls.target.lerp(_v1, 1 - Math.pow(0.001, dt));

      const dist = focusDistanceOf(ref);
      _v2.copy(camera.position).sub(controls.target);
      if (_v2.lengthSq() < 1e-6) _v2.set(0.35, 0.5, 1);
      _v2.normalize();

      _v3.copy(_v1).addScaledVector(_v2, dist);
      camera.position.lerp(_v3, 1 - Math.pow(0.004, dt));

      if (camera.position.distanceTo(_v3) < dist * 0.08) {
        state.focusPhase = 'locked';
        _prevFocusPos.copy(_v1);
      }
    } else if (state.focusPhase === 'locked') {
      // 锁定后相机随行星一起平移，保持相对视角不变
      _v2.copy(_v1).sub(_prevFocusPos);
      camera.position.add(_v2);
      controls.target.add(_v2);
      _prevFocusPos.copy(_v1);
    }
  }

  /* ============================================================
     十一、信息面板
     ============================================================ */

  let activeRef = null;

  function openInfo(ref) {
    activeRef = ref;
    const d = ref.data;

    const facts = (d.facts || []).map(f =>
      '<div class="fact">' +
        '<span class="fact-k">' + f[0] + '</span>' +
        '<span class="fact-v">' + f[1] + '</span>' +
      '</div>'
    ).join('');

    const highlights = (d.highlights && d.highlights.length)
      ? '<div class="info-section">' +
          '<h4 class="info-h4">要点速览</h4>' +
          '<ul class="hi-list">' + d.highlights.map(h => '<li>' + h + '</li>').join('') + '</ul>' +
        '</div>'
      : '';

    const rgb = d.color !== undefined
      ? '#' + new THREE.Color(d.color).getHexString()
      : '#5ee7ff';

    dom.infoBody.innerHTML =
      '<div class="info-head" style="--accent:' + rgb + '">' +
        '<div class="info-badge">' + (d.badge || d.type || '') + '</div>' +
        '<h2 class="info-title">' + d.name + '</h2>' +
        '<div class="info-sub">' + (d.en || '') + ' · ' + (d.type || '') + '</div>' +
      '</div>' +
      '<div class="info-section">' +
        '<h4 class="info-h4">物理参数</h4>' +
        '<div class="fact-grid">' + facts + '</div>' +
      '</div>' +
      '<div class="info-section">' +
        '<h4 class="info-h4">概述</h4>' +
        '<p class="info-desc">' + (d.desc || '') + '</p>' +
      '</div>' +
      highlights +
      '<button class="info-action" id="btn-go">聚焦观测 →</button>';

    dom.info.classList.add('is-open');
    dom.infoBody.scrollTop = 0;

    const goBtn = document.getElementById('btn-go');
    if (goBtn) goBtn.addEventListener('click', () => focusOn(ref));

    // 高亮列表中的对应项
    Array.prototype.forEach.call(dom.listItems, el => {
      el.classList.toggle('is-active', el.dataset.id === d.id);
    });
  }

  function closeInfo() {
    activeRef = null;
    dom.info.classList.remove('is-open');
    Array.prototype.forEach.call(dom.listItems, el => el.classList.remove('is-active'));
  }

  /* ============================================================
     十二、左侧天体列表
     ============================================================ */

  function buildList() {
    const items = [];

    items.push({
      ref: sunRef,
      id: SOLAR_SYSTEM.sun.id,
      name: SOLAR_SYSTEM.sun.name,
      en: SOLAR_SYSTEM.sun.en,
      type: SOLAR_SYSTEM.sun.type,
      color: '#ffd27a'
    });

    planets.forEach(p => {
      items.push({
        ref: p,
        id: p.data.id,
        name: p.data.name,
        en: p.data.en,
        type: p.data.type,
        color: '#' + new THREE.Color(p.data.color).getHexString(),
        dwarf: !!p.data.dwarf
      });
      // 卫星作为二级项
      if (p.moons && p.moons.length) {
        p.moons.forEach(m => {
          items.push({
            ref: m,
            id: m.data.id,
            name: m.data.name,
            en: '',
            type: '卫星',
            color: '#8b98a8',
            child: true
          });
        });
      }
    });

    dom.planetList.innerHTML = items.map(it =>
      '<button class="p-item' + (it.child ? ' is-child' : '') + (it.dwarf ? ' is-dwarf' : '') + '" data-id="' + it.id + '">' +
        '<span class="p-dot" style="--c:' + it.color + '"></span>' +
        '<span class="p-name">' + it.name + '</span>' +
        '<span class="p-type">' + it.type + '</span>' +
      '</button>'
    ).join('');

    dom.listItems = dom.planetList.querySelectorAll('.p-item');
    Array.prototype.forEach.call(dom.listItems, (el, i) => {
      el.addEventListener('click', () => {
        const target = items[i].ref;
        openInfo(target);
        focusOn(target);
      });
    });
  }

  /* ============================================================
     十三、动画主循环
     ============================================================ */

  function updateBodies(dt) {
    const step = state.paused ? 0 : dt * state.timeScale;

    // 太阳自转
    if (sunRef) sunRef.mesh.rotation.y += sunRef.spin * BASE_SPIN_SPEED * step;

    planets.forEach(p => {
      // 公转
      p.angle += p.data.speed * BASE_ORBIT_SPEED * step;
      p.orbitContainer.rotation.y = p.angle;

      // 自转
      p.spinAngle += p.data.spin * BASE_SPIN_SPEED * step;
      p.mesh.rotation.y = p.spinAngle;

      // 云层以稍快的速度漂移
      if (p.clouds) p.clouds.rotation.y = p.spinAngle * 1.14;

      // 卫星
      p.moons.forEach(m => {
        m.angle += m.speed * BASE_ORBIT_SPEED * step;
        m.pivot.rotation.y = m.angle;
        m.mesh.rotation.y = m.angle;   // 潮汐锁定：永远以同一面朝向母星
      });
    });

    // 小行星带
    if (beltMesh && step > 0) {
      for (let i = 0; i < beltData.length; i++) {
        beltData[i].angle += beltData[i].speed * step;
      }
      applyBeltMatrices();
    }

    // 星空极缓慢自转，制造沉浸感
    if (starField) {
      starField.rotation.y += 0.0035 * dt;
      starFieldFar.rotation.y -= 0.0018 * dt;
    }
  }

  function updateHover() {
    if (pointer.x < -5) return;   // 指针尚未进入画面
    const ref = pickAtPointer();
    setHovered(ref);
  }

  /** 相机越靠近太阳，辉光越收敛，否则贴近时整屏都会泛白 */
  function updateSunGlow() {
    if (!sunRef || !sunRef.glows) return;
    const dist = camera.position.length();
    const fade = Math.max(0.20, Math.min(1, (dist - 5) / 68));
    sunRef.glows.forEach(s => {
      s.material.opacity = s.userData.baseOpacity * fade;
    });
  }

  let hoverTimer = 0;

  function animate() {
    requestAnimationFrame(animate);

    const dt = Math.min(clock.getDelta(), 0.05);

    updateBodies(dt);
    updateFocus(dt);
    updateSunGlow();
    if (controls.enabled) controls.update();

    // 悬停检测不需要每帧都做，隔帧执行足够跟手
    hoverTimer += dt;
    if (hoverTimer > 0.05) {
      hoverTimer = 0;
      updateHover();
    }

    if (composer) {
      composer.render(dt);
    } else {
      renderer.render(scene, camera);
    }
  }

  /* ============================================================
     十四、尺寸变化
     ============================================================ */

  function onResize() {
    const w = window.innerWidth, h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
    if (composer) composer.setSize(w, h);
    if (bloomPass) bloomPass.setSize(w, h);
  }

  /* ============================================================
     十五、UI 绑定
     ============================================================ */

  let dragMoved = false;

  function bindUI() {
    // 暂停 / 继续
    dom.btnPause.addEventListener('click', () => {
      state.paused = !state.paused;
      dom.btnPause.classList.toggle('is-on', state.paused);
      dom.btnPause.querySelector('.btn-label').textContent = state.paused ? '继续' : '暂停';
    });

    // 速度滑块
    dom.speedRange.addEventListener('input', () => {
      state.timeScale = parseFloat(dom.speedRange.value);
      dom.speedValue.textContent = state.timeScale.toFixed(1) + '×';
    });

    // 轨道线
    dom.btnOrbits.addEventListener('click', () => {
      state.showOrbits = !state.showOrbits;
      dom.btnOrbits.classList.toggle('is-on', state.showOrbits);
      orbitLines.forEach(l => (l.visible = state.showOrbits));
    });

    // 辉光
    dom.btnGlow.addEventListener('click', () => {
      state.bloomOn = !state.bloomOn;
      dom.btnGlow.classList.toggle('is-on', state.bloomOn);
      if (bloomPass) bloomPass.enabled = state.bloomOn;
    });

    // 重置视角
    dom.btnReset.addEventListener('click', () => {
      releaseFocus();
      closeInfo();
      camera.position.set(0, 55, 118);
      controls.target.set(0, 0, 0);
      controls.update();
    });

    // 解除跟随
    dom.follow.addEventListener('click', () => {
      releaseFocus();
    });

    // 关闭信息面板
    dom.btnCloseInfo.addEventListener('click', () => {
      closeInfo();
      releaseFocus();
    });

    // 键盘
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeInfo();
        releaseFocus();
      } else if (e.key === ' ') {
        e.preventDefault();
        dom.btnPause.click();
      }
    });

    // 画布事件
    const canvas = dom.canvas;
    let downX = 0, downY = 0;

    canvas.addEventListener('pointerdown', e => {
      downX = e.clientX; downY = e.clientY; dragMoved = false;
      // 同步拾取坐标。pointer 原本只在 pointermove 里更新，触屏（没有 move 事件）
      // 以及"指针没先移动就直接点击"时它会停在初始的屏幕外坐标，
      // 于是 pointerup 的拾取永远落空、点不中任何天体。
      updatePointerFromEvent(e);
    });
    canvas.addEventListener('pointermove', e => {
      onPointerMove(e);
      if (Math.abs(e.clientX - downX) > 4 || Math.abs(e.clientY - downY) > 4) dragMoved = true;
    });
    canvas.addEventListener('pointerup', onClick);
    canvas.addEventListener('pointerleave', () => {
      pointer.x = -10; pointer.y = -10;
      setHovered(null);
    });

    // 触屏：不做悬停
    canvas.addEventListener('touchstart', () => setHovered(null), { passive: true });
  }

  /* ============================================================
     十六、启动
     ============================================================ */

  async function boot() {
    [
      'scene', 'loading', 'loading-bar', 'loading-label', 'loading-pct',
      'tooltip', 'planet-list', 'info', 'info-body', 'btn-close-info',
      'btn-pause', 'btn-reset', 'btn-orbits', 'btn-glow',
      'speed-range', 'speed-value', 'follow', 'follow-name'
    ].forEach(id => {
      const camel = id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      dom[camel] = document.getElementById(id);
    });
    dom.canvas = dom.scene;
    dom.canvas.style.cursor = 'grab';

    initRenderer();
    initComposer();
    initLights();

    // 先造星空，加载过程中也有东西可看
    createStarField();

    await buildTextures((p, label) => {
      dom.loadingBar.style.width = (p * 100).toFixed(1) + '%';
      dom.loadingLabel.textContent = label;
      dom.loadingPct.textContent = Math.round(p * 100) + '%';
    });

    createSun();
    SOLAR_SYSTEM.planets.forEach(createPlanet);
    createOrbits();
    createAsteroidBelt();

    buildList();
    bindUI();

    dom.loading.classList.add('is-done');

    // 入场：相机从远处缓缓推近，期间锁住交互，避免与动画打架
    const from = new THREE.Vector3(0, 175, 380);
    const to = new THREE.Vector3(0, 55, 118);
    camera.position.copy(from);
    controls.enabled = false;

    const introMs = 2200;
    const t0 = performance.now();

    (function intro() {
      const t = Math.min((performance.now() - t0) / introMs, 1);
      const k = easeInOutCubic(t);
      camera.position.lerpVectors(from, to, k);
      camera.lookAt(0, 0, 0);
      if (t < 1) {
        requestAnimationFrame(intro);
      } else {
        controls.target.set(0, 0, 0);
        controls.enabled = true;
        controls.update();
        state.booted = true;
      }
    })();

    animate();
  }

  /* ---------------- Gamma 校正着色器 ---------------- */
  // EffectComposer 的渲染目标工作在线性空间，
  // 直接输出会整体偏暗，因此补一道 sRGB 编码。
  THREE.GammaCorrectionShader = {
    uniforms: { tDiffuse: { value: null } },
    vertexShader: [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);',
      '}'
    ].join('\n'),
    fragmentShader: [
      'uniform sampler2D tDiffuse;',
      'varying vec2 vUv;',
      // 不能用 LinearTosRGB 这个名字：three 的着色器前缀里已经定义了同名函数，
      // 重复定义会让整个 program 编译失败
      'vec4 solarisEncodeSRGB(vec4 value) {',
      '  return vec4(mix(pow(value.rgb, vec3(0.41666)) * 1.055 - vec3(0.055),',
      '    value.rgb * 12.92, vec3(lessThanEqual(value.rgb, vec3(0.0031308)))), value.a);',
      '}',
      'void main() {',
      '  gl_FragColor = solarisEncodeSRGB(texture2D(tDiffuse, vUv));',
      '}'
    ].join('\n')
  };

  // 启动失败时把原因显示出来，好过让加载屏一直挂着
  window.addEventListener('DOMContentLoaded', () => {
    boot().catch(err => {
      console.error(err);
      const el = document.getElementById('loading-label');
      if (el) el.textContent = '启动失败：' + (err && err.message ? err.message : err);
    });
  });

})();
