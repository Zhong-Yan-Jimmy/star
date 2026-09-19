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
    booted: false,
    mode: 'solar',        // solar | star
    switching: false
  };

  /* 两个模式各自的相机参数与初始机位。
     near / far 刻意不在这里：恒星模式近处 3 单位起步、最远 125 单位，
     太阳系那套 0.1 / 4000 的视锥富余得多，动它只会白白引入深度精度问题。 */
  const MODE_VIEW = {
    solar: { home: new THREE.Vector3(0, 55, 118), minDist: 1.1, maxDist: 620 },
    star:  { home: new THREE.Vector3(0, 42, 96),  minDist: 3.0, maxDist: 400 }
  };

  let renderer, scene, camera, controls, composer, bloomPass, clock;
  let starField, starFieldFar, beltMesh;
  let sunRef = null;
  let sunStarRef = null;       // 恒星世界里原点上的那个太阳标记
  let worldSolar, worldStars;

  const planets = [];          // 行星运行时对象
  const moonRefs = [];         // 所有卫星运行时对象
  const pickables = [];        // 可拾取目标（太阳系）
  const starPickables = [];    // 可拾取目标（恒星）
  const STAR_REFS = [];        // 恒星运行时对象，与 NEARBY_STARS 一一对应
  const orbitLines = [];
  const beltData = [];

  /* 拾取层。恒星那 141 个隐形拾取球扔在这一层上：相机只渲染 layer 0，
     看不见它们；而射线看得见——three 的 Raycaster 本来就是按 layers 工作的。
     这比给它们 opacity: 0 干净得多，透明对象照样要提交 drawcall，
     141 个隐形球就是每帧 141 次白烧。 */
  const PICK_LAYER = 2;

  // 复用的临时对象，避免在循环里频繁分配
  const _v1 = new THREE.Vector3();
  const _v2 = new THREE.Vector3();
  const _v3 = new THREE.Vector3();
  const _m4 = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _s = new THREE.Vector3();

  const raycaster = new THREE.Raycaster();
  /* 默认只看 layer 0，得把拾取层显式打开，否则恒星那颗也点不中 */
  raycaster.layers.enable(PICK_LAYER);
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

  /* 两个世界各装进一个 Group。用 visible 切换而不是 add / remove：
     行星的公转角、自转角、卫星轨道都留在对象上，切回来是接着走而不是
     从头开始，也省掉一次一百多个对象的重建。
     灯光和两片星空背景不进任何一组——那是两个模式共用的天幕。 */
  function initWorlds() {
    worldSolar = new THREE.Group();
    worldStars = new THREE.Group();
    worldStars.visible = false;
    scene.add(worldSolar, worldStars);
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
    worldSolar.add(anchor);

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
    worldSolar.add(orbitContainer);

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
      worldSolar.add(line);
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

    worldSolar.add(beltMesh);
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
     八、邻近恒星世界
     ============================================================ */

  /* 赤道坐标 → 场景坐标。把天球赤道面摆成 XZ 平面、Y 轴指向北天极：
     这样从太阳望出去，每颗星的方位与真实星空一致，星座的相对形状自然
     成立。距离走幂律压缩，方向一个字节都不动。
     ra 的单位是小时，乘 15 才是度 —— 这份数据最容易看走眼的一处。 */
  function starPosition(s, out) {
    const r = STAR_SCALE * Math.pow(s.dist, STAR_GAMMA);
    const ra = s.ra * 15 * Math.PI / 180;
    const dec = s.dec * Math.PI / 180;
    const cd = Math.cos(dec);
    /* 最后一项取负：赤经往东增加，而 three 里 +Z 指向观察者，
       不取负的话从天极往下看天球会转反，星座左右镜像。 */
    return out.set(r * cd * Math.cos(ra), r * Math.sin(dec), -r * cd * Math.sin(ra));
  }

  function magBucketOf(mag) {
    const m = (mag === null || mag === undefined || !isFinite(mag)) ? Infinity : mag;
    const i = STAR_MAG_BUCKETS.findIndex(b => m < b.max);
    return i < 0 ? STAR_MAG_BUCKETS.length - 1 : i;
  }

  function buildStarWorld() {
    /* 全项目最大的性能陷阱就在这一行：makeGlowTexture 是 256×256 的逐像素
       循环，而且不缓存。给 141 颗星各调一次就是约 3700 万次像素运算、
       几十 MB 的画布，会卡死好几秒。只调这一次，5 个 Points 和太阳辉光共用。 */
    const glowTex = TexGen.makeGlowTexture([255, 255, 255], 2.2);
    const c = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };

    /* PointsMaterial 的 size 是整组共用的而 vertexColors 是逐顶点的，
       所以光谱色能进顶点色、星等不能进大小 —— 只能按星等分桶，一组一尺寸。
       5 个桶 = 5 次 drawcall。 */
    const groups = STAR_MAG_BUCKETS.map(() => []);
    NEARBY_STARS.forEach(s => groups[magBucketOf(s.mag)].push(s));

    groups.forEach((list, bi) => {
      if (!list.length) return;
      const cfg = STAR_MAG_BUCKETS[bi];
      const pos = new Float32Array(list.length * 3);
      const col = new Float32Array(list.length * 3);

      list.forEach((s, k) => {
        starPosition(s, _v1);
        pos[k * 3] = _v1.x; pos[k * 3 + 1] = _v1.y; pos[k * 3 + 2] = _v1.z;

        c.setHex(s.color);
        /* 褐矮星的颜色本身就是暗红到近黑，落在深蓝底上就是一团看不见的
           污渍。给亮度兜个底，保住「那儿确实有东西」这件事。 */
        c.getHSL(hsl);
        if (hsl.l < 0.36) c.setHSL(hsl.h, hsl.s, 0.36);
        /* 桶内再按星等的残余量做 ±22% 亮度微调，把 5 级台阶抹成连续的：
           桶里最亮的那个最亮，挨着下一档的暗一点，跨过桶边界看不出跳变。
           mag 拿不到的按本桶最暗算 —— 不能让它变成 NaN 灌进顶点色。 */
        const m = (s.mag === null || s.mag === undefined || !isFinite(s.mag)) ? cfg.max : s.mag;
        const lo = bi === 0 ? -1.6 : STAR_MAG_BUCKETS[bi - 1].max;
        const t = Math.min(Math.max((m - lo) / (cfg.max - lo), 0), 1);
        c.multiplyScalar(1.22 - 0.44 * t);

        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

      worldStars.add(new THREE.Points(geo, new THREE.PointsMaterial({
        size: cfg.size,
        map: glowTex,
        vertexColors: true,
        transparent: true,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        sizeAttenuation: true
      })));
    });

    /* 每颗星配一个隐形拾取球。它们扔在 PICK_LAYER 上：相机只渲染 layer 0，
       看不见；而 raycaster.layers 显式打开了这一层，看得见。这比给它们
       opacity: 0 干净得多 —— 透明对象照样要提交 drawcall，141 个隐形球
       就是每帧 141 次白烧。
       球必须自己进扁平数组：intersectObjects(..., false) 是非递归的。 */
    /* 半径 1.5 是拿屏幕像素定的：暗星的点在初始机位下只有 4 个像素宽，
       拿它当靶子等于让人用针尖戳；1.5 的球在屏幕上约 15px 宽，
       是「大概朝那儿点」就能中的尺寸，又不至于把旁边的星一起罩进来。
       球不渲染，遮不住东西。 */
    const hitGeo = new THREE.SphereGeometry(1.5, 8, 6);
    const hitMat = new THREE.MeshBasicMaterial();

    NEARBY_STARS.forEach(s => {
      starPosition(s, _v1);
      const anchor = new THREE.Object3D();
      anchor.position.copy(_v1);
      worldStars.add(anchor);

      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.layers.set(PICK_LAYER);
      anchor.add(hit);

      const ref = {
        kind: 'star',
        data: s,
        anchor: anchor,
        mesh: hit,
        /* 恒星的「身体」是 5 个 Points 里的一个顶点，没有自己的网格和材质
           可以点亮。setHovered 里原来那套改 emissive 的高亮在这儿无处落脚，
           改走共用的 hover 环（见第十节）。 */
        mat: null,
        glow: null
      };
      hit.userData.ref = ref;
      starPickables.push(hit);
      STAR_REFS.push(ref);
    });

    /* 太阳在恒星世界里就是原点，得给它一个落点：否则「所有距离都从这里
       量起」在画面里没有着落，左栏列表第一项也点不动。
       用同一张辉光纹理染色，不再多调一次那个逐像素循环。 */
    const sunData = Object.assign({}, SOLAR_SYSTEM.sun, { radius: 2.4 });
    const sunAnchor = new THREE.Object3D();
    worldStars.add(sunAnchor);

    const sunGlow = new THREE.Sprite(new THREE.SpriteMaterial({
      map: glowTex,
      color: 0xffc46b,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    /* 太阳是离我们最近的那颗恒星，在星野里该是最亮的；但它也不该亮成
       一团糊住半个天球的雾 —— 它是这一百多颗里的一员，不是这个模式的主角 */
    sunGlow.scale.setScalar(3.6);
    sunAnchor.add(sunGlow);

    const sunHit = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10), hitMat);
    sunHit.layers.set(PICK_LAYER);
    sunAnchor.add(sunHit);

    sunStarRef = {
      kind: 'star', data: sunData, anchor: sunAnchor,
      mesh: sunHit, mat: null, glow: sunGlow
    };
    sunHit.userData.ref = sunStarRef;
    starPickables.push(sunHit);

    /* 射线用的是 matrixWorld，而它要到渲染时才更新，偏偏悬停检测跑在
       渲染前面。不先算这一遍，第一帧所有拾取球都还堆在原点。 */
    worldStars.updateMatrixWorld(true);
  }

  /* ============================================================
     九、纹理预生成（带进度回调）
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
     十、交互：悬停与拾取
     ============================================================ */

  function updatePointerFromEvent(e) {
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
    pointer.y = -(e.clientY / window.innerHeight) * 2 + 1;
  }

  /* 拾取目标必须真的换数组，不能靠 worldSolar.visible = false 来屏蔽：
     three 的 Raycaster 只测 layers、不看 object.visible（这是 #19475 里
     明确移除的行为），藏起来的太阳系天体照样会被射线命中。
     六处 pickables.push 分布在太阳 / 行星 / 卫星的构造函数里，全都不用动 ——
     分流只在这一处读取点上做。 */
  function activePickables() {
    return state.mode === 'star' ? starPickables : pickables;
  }

  function pickAtPointer() {
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(activePickables(), false);
    return hits.length ? hits[0].object.userData.ref : null;
  }

  /* hover 环。恒星的「身体」是 5 个 Points 里的一个顶点，不属于任何一颗，
     没有材质可以点亮（太阳系那边的做法是改 emissive）—— 所以改用一只共用
     的光环挪过去。141 个环没必要，一个就够。 */
  let hoverRing = null;

  function createHoverRing() {
    hoverRing = new THREE.Sprite(new THREE.SpriteMaterial({
      map: TexGen.makeGlowTexture([255, 255, 255], 1.15),
      color: 0x5ee7ff,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    }));
    hoverRing.visible = false;
    /* 挂 scene 而不挂 worldStars：它是选中状态的一部分，跟天体属于哪个
       世界无关。切模式时由 applyMode 里的 setHovered(null) 收掉。 */
    scene.add(hoverRing);
  }

  /* 名字和光标只看「有没有悬停到东西」，高亮是另一回事。
     原来这两件事被绑在 ref.mat.emissive 上（`if (ref && ref.mat && ...)`），
     于是没有 emissive 的太阳既不出名字、光标也不变手型 —— 恒星更没有，
     一整个模式都点不出反应。拆开之后两边都好了。 */
  function setHovered(ref) {
    if (state.hovered === ref) return;

    const prev = state.hovered;
    if (prev && prev.mat && prev.mat.emissive) prev.mat.emissive.setHex(0x000000);
    if (hoverRing) hoverRing.visible = false;

    state.hovered = ref;

    if (!ref) {
      dom.tooltip.classList.remove('is-visible');
      dom.canvas.style.cursor = 'grab';
      return;
    }

    dom.tooltip.textContent = ref.data.name +
      (ref.data.en && ref.data.en !== ref.data.name ? ' · ' + ref.data.en : '');
    dom.tooltip.classList.add('is-visible');
    dom.canvas.style.cursor = 'pointer';

    if (ref.mat && ref.mat.emissive) {
      // 微微自发光，配合 bloom 形成一圈淡淡的描边
      ref.mat.emissive.setHex(0x1d3d5c);
    } else if (hoverRing) {
      // 光环大小跟着那颗星的显示尺寸走，不然暗星套个环反而比星还亮
      worldPosOf(ref, _v1);
      hoverRing.position.copy(_v1);
      hoverRing.scale.setScalar(Math.max(ref.data.radius * 2.4, 2.2));
      hoverRing.visible = true;
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
     十一、相机聚焦与跟随
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
     十二、模式切换
     ============================================================ */

  /* 换场放在拉远的中点做：那一刻画面里没有静止的参照物，
     两个世界的显隐差异看不出接缝。三段式——拉远、换场、推近。 */
  const _sw = {
    active: false, phase: 0, t: 0, mode: null,
    from: new THREE.Vector3(),
    mid: new THREE.Vector3(),
    to: new THREE.Vector3()
  };

  function switchMode(mode) {
    /* 三个守卫缺一不可：入场动画期间相机正被另一段补间直接改着（boot 里
       的 intro），此时插进来两段补间会抢同一个 camera.position。 */
    if (state.switching || !state.booted || mode === state.mode) return;
    const view = MODE_VIEW[mode];
    if (!view) return;

    state.switching = true;
    /* 带阻尼的 OrbitControls 会拿内部球坐标把相机拽回去，和手写补间直接
       打架。boot 的入场动画用的是同一招。 */
    controls.enabled = false;

    _sw.from.copy(camera.position);
    _sw.mode = mode;
    _sw.phase = 0;
    _sw.t = 0;

    /* 沿当前视线方向退到远处，中途把 y 抬起来画一道浅弧 ——
       直线后退会从太阳本体里穿过去。 */
    const axis = _sw.from.lengthSq() < 1e-6
      ? new THREE.Vector3(0, 0.6, 1).normalize()
      : _sw.from.clone().normalize();
    const far = Math.max(_sw.from.length(), view.home.length()) * 2.4;
    _sw.mid.copy(axis.multiplyScalar(far));
    _sw.mid.y = Math.max(_sw.mid.y, far * 0.42);
    _sw.to.copy(view.home);

    _sw.active = true;
  }

  function updateSwitch(dt) {
    if (!_sw.active) return;
    _sw.t += dt;

    if (_sw.phase === 0) {
      camera.position.lerpVectors(_sw.from, _sw.mid, easeInOutCubic(Math.min(_sw.t / 0.5, 1)));
      camera.lookAt(0, 0, 0);
      if (_sw.t >= 0.5) {
        applyMode(_sw.mode);
        _sw.phase = 1;
        _sw.t = 0;
        _sw.from.copy(camera.position);
      }
      return;
    }

    camera.position.lerpVectors(_sw.from, _sw.to, easeInOutCubic(Math.min(_sw.t / 0.75, 1)));
    camera.lookAt(0, 0, 0);
    if (_sw.t >= 0.75) {
      _sw.active = false;
      controls.target.set(0, 0, 0);
      controls.enabled = true;
      controls.update();
      state.switching = false;
    }
  }

  /** 换场：同一帧里把该改的都改完 */
  function applyMode(mode) {
    state.mode = mode;

    worldSolar.visible = mode === 'solar';
    worldStars.visible = mode === 'star';

    /* 内层假星场在恒星模式必须藏起来：真星最远才 125 单位，而假星铺在
       420–900 的球壳上，两者会混进同一片天区，「每颗星的方位都与真实星空
       一致」这件事就说不清了。外层那圈银河带留着当深空底。 */
    if (starField) starField.visible = mode === 'solar';

    const view = MODE_VIEW[mode];
    controls.minDistance = view.minDist;
    controls.maxDistance = view.maxDist;

    setHovered(null);
    closeInfo();
    releaseFocus();

    /* 列表换榜放在换场的中点：那一刻画面里没有静止参照物，一行行文字
       当着人面重排会很难看。这里也顺手把上一条选中项的清空做了 ——
       closeInfo 清的是旧榜上的 .is-active，旧榜这会儿已经被换掉了。 */
    renderList(mode === 'solar' ? solarListItems() : starListItems());

    if (dom.btnMode) {
      dom.btnMode.textContent = mode === 'solar' ? '邻近恒星' : '返回太阳系';
    }
    if (dom.listLabel) {
      const span = dom.listLabel.querySelector('span');
      if (span) span.textContent = mode === 'solar' ? '天体索引 / INDEX' : '邻近恒星 / NEARBY';
    }
    if (dom.listCredit) dom.listCredit.hidden = mode !== 'star';
  }

  /* ============================================================
     十三、信息面板
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

    /* 地球是全场景里唯一有详细地理版的天体——TERRA 就是从 SOLARIS 派生出去的
       地球专题。用 <a href> 而不是再接一个 button + JS 跳转：新标签页打开、中键
       点击、右键「在新标签页中打开」、悬停时看得到去向，浏览器原生全给了。
       rel="noopener" 不是可选的，少了它 TERRA 那页能通过 window.opener 反向操作
       这一页。路径是相对的：本地两个目录同在 code/ 下，线上两个站同在
       <user>.github.io 下，同一条 ../terra/index.html 两边都成立 */
    const terraLink = d.id === 'earth'
      ? '<a class="info-action info-action-ext" href="../terra/index.html"' +
        ' target="_blank" rel="noopener">进入 TERRA · 地理探索 ↗</a>'
      : '';

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
      '<button class="info-action" id="btn-go">聚焦观测 →</button>' +
      terraLink;

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
     十四、左侧天体列表
     ============================================================ */

  function solarListItems() {
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

    return items;
  }

  function starListItems() {
    const items = [];

    /* 太阳排在最前。恒星模式里所有距离都从它量起，它自己不在这张表上的话，
       「4.23 光年」这个数字就没有起点。用太阳系那份 data —— 点开是同
       一份档案，这也是对的。 */
    items.push({
      ref: sunStarRef,
      id: SOLAR_SYSTEM.sun.id,
      name: SOLAR_SYSTEM.sun.name,
      en: SOLAR_SYSTEM.sun.en,
      type: '0 ly',
      color: '#ffd27a'
    });

    /* 顺序直接沿用 NEARBY_STARS 的顺序（按距离升序）。这里不做 .sort() ——
       排序必须在产出 items 之前就完成，理由见 renderList 上那段。 */
    STAR_REFS.forEach(ref => {
      const s = ref.data;
      items.push({
        ref: ref,
        id: s.id,
        name: s.name,
        en: s.en,
        type: s.dist.toFixed(2) + ' ly',
        color: '#' + new THREE.Color(s.color).getHexString()
      });
    });

    return items;
  }

  function renderList(items) {
    dom.planetList.innerHTML = items.map(it =>
      '<button class="p-item' + (it.child ? ' is-child' : '') + (it.dwarf ? ' is-dwarf' : '') + '" data-id="' + it.id + '">' +
        '<span class="p-dot" style="--c:' + it.color + '"></span>' +
        '<span class="p-name">' + it.name + '</span>' +
        '<span class="p-type">' + it.type + '</span>' +
      '</button>'
    ).join('');

    /* 下面这两段是本文件最脆的一处：点击绑定读的是 items[i]，而下标来自
       querySelectorAll 的顺序 —— 两者必须严格一一对应，所以中间不许插
       任何东西。插一次过滤、一个条件渲染，下标就错位，点「火星」会打开
       木星。items 的排序也必须在进这个函数之前就做完：在这儿 sort 一次，
       绑定就全对错人了。 */
    dom.listItems = dom.planetList.querySelectorAll('.p-item');
    Array.prototype.forEach.call(dom.listItems, (el, i) => {
      el.addEventListener('click', () => {
        const target = items[i].ref;
        openInfo(target);
        focusOn(target);
      });
    });

    // 换榜要回到顶部，否则会继承上一份的滚动位置
    dom.planetList.scrollTop = 0;
  }

  /* ============================================================
     十五、动画主循环
     ============================================================ */

  function updateBodies(dt) {
    // 星空背景两个模式共用，永远转
    if (starField) {
      starField.rotation.y += 0.0035 * dt;
      starFieldFar.rotation.y -= 0.0018 * dt;
    }

    /* 恒星模式下把太阳系整个冻住：1400 个碎石实例每帧重算矩阵纯属白烧，
       而且切回来会发现行星全跑到别处去了，不如原样停在那里。
       注意 worldStars 本身绝对不能自转 —— 真实星空靠的就是「每颗星的方位
       与天球坐标一致」，一转，星座的相对位置就全废了。这是全项目唯一一处
       不能照搬星场惯例的地方。 */
    if (state.mode !== 'solar') return;

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
  }

  function updateHover() {
    if (pointer.x < -5) return;   // 指针尚未进入画面
    const ref = pickAtPointer();
    setHovered(ref);
  }

  /** 相机越靠近太阳，辉光越收敛，否则贴近时整屏都会泛白 */
  function updateSunGlow() {
    if (state.mode !== 'solar') return;   // 太阳藏起来了，辉光跟着停
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
    updateSwitch(dt);
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
     十六、尺寸变化
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
     十七、UI 绑定
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

    // 切换模式
    dom.btnMode.addEventListener('click', () => {
      switchMode(state.mode === 'solar' ? 'star' : 'solar');
    });

    // 重置视角
    dom.btnReset.addEventListener('click', () => {
      releaseFocus();
      closeInfo();
      // 机位要读当前模式的：写死太阳系那套的话，在恒星模式点重置会被弹回去
      camera.position.copy(MODE_VIEW[state.mode].home);
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
     十八、启动
     ============================================================ */

  async function boot() {
    [
      'scene', 'loading', 'loading-bar', 'loading-label', 'loading-pct',
      'tooltip', 'planet-list', 'info', 'info-body', 'btn-close-info',
      'btn-pause', 'btn-reset', 'btn-orbits', 'btn-glow', 'btn-mode', 'list-label',
      'list-credit',
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
    initWorlds();

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
    buildStarWorld();
    createHoverRing();

    renderList(solarListItems());
    bindUI();

    dom.loading.classList.add('is-done');

    /* 入场：相机从远处缓缓推近，期间锁住交互，避免与动画打架。
       模式按钮也要一起锁 —— 入场期间它和 intro 补间会抢同一个 camera.position */
    const from = new THREE.Vector3(0, 175, 380);
    const to = MODE_VIEW.solar.home.clone();
    camera.position.copy(from);
    controls.enabled = false;
    dom.btnMode.disabled = true;

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
        dom.btnMode.disabled = false;
      }
    })();

    animate();

    /* 给 tools/check-page.mjs 用。相机参数、模式状态、拾取列表全在这个 IIFE
       的闭包里，不暴露的话检查脚本只能靠截图猜 —— 比如 controls.maxDistance
       换没换，从外面根本看不出来。暴露的成本是零。 */
    window.__solaris = {
      state, camera, controls, scene, worldSolar, worldStars,
      planets, sunRef, activePickables, switchMode, MODE_VIEW,
      stars: NEARBY_STARS,
      starRefs: STAR_REFS, starPickables, sunStarRef, starPosition,
      STAR_SCALE, STAR_GAMMA,
      ring: () => hoverRing
    };
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
