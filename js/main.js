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
    /* 天球壳的开关。刻意和 showOrbits 分开记：两个模式各记各的，
       在恒星模式关掉星座线不该顺手把太阳系的轨道线也关了。 */
    showSky: true,
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
    /* 280 < 壳半径 300：相机永远待在壳**里**。壳星和星座线都是
       depthWrite: false，没有东西遮挡远半球，一出去就看到前后两层星叠着
       同一个星座的两个副本，星密度凭空翻倍。留 20 的余量，免得贴到壳面
       上时内壁摊成一张平面。 */
    star:  { home: new THREE.Vector3(0, 42, 96),  minDist: 3.0, maxDist: 280 }
  };

  let renderer, scene, camera, controls, composer, bloomPass, clock;
  let starField, starFieldFar, beltMesh;
  let sunRef = null;
  let sunStarRef = null;       // 恒星世界里原点上的那个太阳标记
  let worldSolar, worldStars;
  /* 点精灵共用的一张纹理。makeGlowTexture 是逐像素循环且不缓存，
     内层 5 个桶、太阳辉光、壳层 4 个桶全用这一张 —— 调第二次就是白烧一次。 */
  let starGlowTex = null;
  let skyGroup = null;         // 天球壳（壳星 + 星座线），挂在 worldStars 下
  let skyLines = null;         // 壳上那 743 段星座线，开关只切它
  let skyConstellations = [];  // 88 个星座的中心方向/中文名/最亮星等，构建时算好
  let skyLabelEls = null;      // 屏幕上那 8 个名字标签，DOM 池（见 updateSkyLayer）

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

  /* 星等落进哪个桶。内层用 STAR_MAG_BUCKETS，天球壳用 SKY_MAG_BUCKETS ——
     两组桶的尺寸量纲不通用（一个按透视倒推、一个是纯像素），所以桶表当参数传。 */
  function magBucketOf(mag, buckets) {
    const m = (mag === null || mag === undefined || !isFinite(mag)) ? Infinity : mag;
    const i = buckets.findIndex(b => m < b.max);
    return i < 0 ? buckets.length - 1 : i;
  }

  function buildStarWorld() {
    /* 全项目最大的性能陷阱就在这一行：makeGlowTexture 是 256×256 的逐像素
       循环，而且不缓存。给 141 颗星各调一次就是约 3700 万次像素运算、
       几十 MB 的画布，会卡死好几秒。只调这一次，5 个 Points、太阳辉光和
       后面的天球壳共用 —— 提到模块作用域就是为了让 buildSkyShell 也拿得到。 */
    starGlowTex = TexGen.makeGlowTexture([255, 255, 255], 2.2);
    const glowTex = starGlowTex;
    const c = new THREE.Color();
    const hsl = { h: 0, s: 0, l: 0 };

    /* PointsMaterial 的 size 是整组共用的而 vertexColors 是逐顶点的，
       所以光谱色能进顶点色、星等不能进大小 —— 只能按星等分桶，一组一尺寸。
       5 个桶 = 5 次 drawcall。 */
    const groups = STAR_MAG_BUCKETS.map(() => []);
    NEARBY_STARS.forEach(s => groups[magBucketOf(s.mag, STAR_MAG_BUCKETS)].push(s));

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

  /* 88 个星座的中文名，键是 sky.js 里 CONSTELLATION_LINES 的键（IAU 三字母缩写）。

     写在这里而不是 sky.js：那个文件是烘好的数据成品，头部注释写明了复现方法，
     手写内容下次重新生成会被冲掉。

     几处译名有分歧的，这里采用的是国家天文名词审定委员会那套：
     蝘蜓座（不是「蝙蝠座」）、剑鱼座（不是「箭鱼座」）、
     印第安座（不是「印地安座」）、唧筒座（不是「唢呐座」）。 */
  const SKY_CONSTELLATION_CN = {
    And: '仙女座', Ant: '唧筒座', Aps: '天燕座', Aqr: '宝瓶座', Aql: '天鹰座',
    Ara: '天坛座', Ari: '白羊座', Aur: '御夫座', Boo: '牧夫座', Cae: '雕具座',
    Cam: '鹿豹座', Cnc: '巨蟹座', CVn: '猎犬座', CMa: '大犬座', CMi: '小犬座',
    Cap: '摩羯座', Car: '船底座', Cas: '仙后座', Cen: '半人马座', Cep: '仙王座',
    Cet: '鲸鱼座', Cha: '蝘蜓座', Cir: '圆规座', Col: '天鸽座', Com: '后发座',
    CrA: '南冕座', CrB: '北冕座', Crv: '乌鸦座', Crt: '巨爵座', Cru: '南十字座',
    Cyg: '天鹅座', Del: '海豚座', Dor: '剑鱼座', Dra: '天龙座', Equ: '小马座',
    Eri: '波江座', For: '天炉座', Gem: '双子座', Gru: '天鹤座', Her: '武仙座',
    Hor: '时钟座', Hya: '长蛇座', Hyi: '水蛇座', Ind: '印第安座', Lac: '蝎虎座',
    Leo: '狮子座', LMi: '小狮座', Lep: '天兔座', Lib: '天秤座', Lup: '豺狼座',
    Lyn: '天猫座', Lyr: '天琴座', Men: '山案座', Mic: '显微镜座', Mon: '麒麟座',
    Mus: '苍蝇座', Nor: '矩尺座', Oct: '南极座', Oph: '蛇夫座', Ori: '猎户座',
    Pav: '孔雀座', Peg: '飞马座', Per: '英仙座', Phe: '凤凰座', Pic: '绘架座',
    Psc: '双鱼座', PsA: '南鱼座', Pup: '船尾座', Pyx: '罗盘座', Ret: '网罟座',
    Sge: '天箭座', Sgr: '人马座', Sco: '天蝎座', Scl: '玉夫座', Sct: '盾牌座',
    Ser: '巨蛇座', Sex: '六分仪座', Tau: '金牛座', Tel: '望远镜座', Tri: '三角座',
    TrA: '南三角座', Tuc: '杜鹃座', UMa: '大熊座', UMi: '小熊座', Vel: '船帆座',
    Vir: '室女座', Vol: '飞鱼座', Vul: '狐狸座'
  };

  /* 天球壳上的位置：方向照搬，距离一律 SKY_RADIUS。
     和 starPosition 是同一套赤道坐标约定（场景里 XZ 面是天赤道、+Y 指北天极，
     最后一项取负的理由见那边），差别只在距离 —— 那边是压缩后的真实距离，
     这边是恒定半径。sky.js 里的 ra 单位是**度**，不是 HYG 那种小时。 */
  function skyPositionOf(ra, dec, out) {
    const a = ra * Math.PI / 180;
    const d = dec * Math.PI / 180;
    const cd = Math.cos(d);
    return out.set(SKY_RADIUS * cd * Math.cos(a),
                   SKY_RADIUS * Math.sin(d),
                   -SKY_RADIUS * cd * Math.sin(a));
  }

  /* 天球壳：内层那 141 颗星按真实三维距离摆，于是这一层里凑不出任何一个
     完整的星座 —— 猎户座那七颗彼此相距几百上千光年，在三维空间里根本不是
     邻居，何况距离还走了一道非线性压缩。星座只在天球上成立。

     所以这里补一层半径固定的球面：星只按**方向**落位，距离一律忽略，
     连线画在球面上。它和内层是各自独立的两张图，**不会重合**——同一个
     天狼星，内层那个是「8.6 光年外的一个真实位置」，壳上那个是「天上那个
     方向」，从离开原点的相机看过去，两者能差出一百多度。这不是 bug，
     是「距离」这件事本身的可视化；壳的立论不是内层的投影演示，而是
     「一张完整的星图」。所以壳做得明显更暗更小，退成背景天幕。 */
  function buildSkyShell() {
    skyGroup = new THREE.Group();
    /* 挂在 worldStars 下而不是 scene：切回太阳系时 worldStars.visible = false
       会把它一起收走，少一处要在 applyMode 里维护的状态。 */
    worldStars.add(skyGroup);

    const c = new THREE.Color();

    /* 按星等分桶，理由和内层一样（PointsMaterial 的 size 整组共用，只有
       vertexColors 能逐顶点）。桶值来自 sky.js —— 注意那组数是**纯像素**。 */
    const groups = SKY_MAG_BUCKETS.map(() => []);
    SKY_STARS_RAW.forEach((s, i) => {
      groups[magBucketOf(s[3], SKY_MAG_BUCKETS)].push(i);   // s = [hip, ra, dec, mag, bv]
    });

    groups.forEach((list, bi) => {
      if (!list.length) return;
      const cfg = SKY_MAG_BUCKETS[bi];
      const pos = new Float32Array(list.length * 3);
      const col = new Float32Array(list.length * 3);

      list.forEach((si, k) => {
        const s = SKY_STARS_RAW[si];
        const mag = s[3];
        skyPositionOf(s[1], s[2], _v1);
        pos[k * 3] = _v1.x; pos[k * 3 + 1] = _v1.y; pos[k * 3 + 2] = _v1.z;

        c.setHex(skyColorFromBV(s[4]));
        /* 整层压暗，让它退到内层后面当天幕。压的是整层而不是某一类星，
           所以光谱色的相对关系一个字没动。

           压到 0.85 而不是更狠：743 条线是一笔连到底的实线，3~8px 的孤立
           暗点根本压不住它 —— 压过头就会变成「线浮在黑底上、端头的星看不
           见」，像凭空画的划痕而不是星座。两边得在同一档亮度上，线才是
           「把星连起来」的那笔。 */
        c.multiplyScalar(0.85);
        /* 桶内再按星等的残余量做亮度微调，把几级台阶抹成连续的（照抄内层做法） */
        const lo = bi === 0 ? -1.6 : SKY_MAG_BUCKETS[bi - 1].max;
        const t = Math.min(Math.max((mag - lo) / (cfg.max - lo), 0), 1);
        c.multiplyScalar(1.2 - 0.4 * t);

        col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
      });

      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geo.setAttribute('color', new THREE.BufferAttribute(col, 3));

      skyGroup.add(new THREE.Points(geo, new THREE.PointsMaterial({
        size: cfg.size,
        map: starGlowTex,
        vertexColors: true, transparent: true,
        depthWrite: false, blending: THREE.AdditiveBlending,
        /* 关键区别：壳层不吃透视。gl_PointSize 直接等于 size，
           相机在壳内怎么走星都一样大 —— 天幕是投影，本来就不该近大远小。
           副作用是这里的 size 是纯 CSS 像素，和内层那组倒推值不通用。 */
        sizeAttenuation: false
      })));
    });

    /* 星座线。743 段合成一个 LineSegments，1 次 drawcall。

       ⚠️ 不设 linewidth：WebGL 下大于 1 的线宽在绝大多数驱动上被忽略
       （Windows 走 ANGLE/D3D11 时 ALIASED_LINE_WIDTH_RANGE 就是 [1,1]），
       写了也是白写。想更粗只能把线扩成三角形条带，不值得。

       材质与壳星同款（加法混合 + depthWrite: false）：全场景的点都是
       depthWrite: false，而所有 Points 的原点都在 (0,0,0)，排序拿的是原点的
       视深，也就是说它们彼此的先后顺序是任意的。加法可交换、又没人写深度，
       所以看不出问题 —— 换成不透明材质立刻显形。 */
    const segs = [];
    Object.keys(CONSTELLATION_LINES).forEach(con => {
      CONSTELLATION_LINES[con].forEach(line => {
        for (let i = 0; i < line.length - 1; i++) {
          if (line[i] !== line[i + 1]) segs.push(line[i], line[i + 1]);
        }
      });
    });

    const lpos = new Float32Array(segs.length * 3);
    /* 逐顶点的淡出系数，只存灰度（r=g=b=f）。线材质自带 color 0x25a0b8，
       basic shader 里最终色是 material.color × vColor，正好等于「主色 × 系数」；
       顶点色里再存一遍颜色就会乘两遍。 */
    const lcol = new Float32Array(segs.length * 3).fill(1);
    segs.forEach((si, k) => {
      const s = SKY_STARS_RAW[si];
      skyPositionOf(s[1], s[2], _v1);
      lpos[k * 3] = _v1.x; lpos[k * 3 + 1] = _v1.y; lpos[k * 3 + 2] = _v1.z;
    });

    const lgeo = new THREE.BufferGeometry();
    lgeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
    lgeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
    skyLines = new THREE.LineSegments(lgeo, new THREE.LineBasicMaterial({
      color: 0x25a0b8,          // 项目主色 #5ee7ff 压到约四成亮度
      /* 0.3 而不是 0.5：加法混合下线条叠加处会自己变亮，0.5 时线的视觉重量
         压过了它连的那些星（星是暗的孤立点，线是连续的）。调亮壳星之外再
         把线压下来，两者才在同一档上。 */
      transparent: true, opacity: 0.3,
      /* 顶点色由 updateSkyLayer 每帧按「离视野中心多远」写进去，屏幕边缘的
         线因此淡出（88 个星座铺满视野会糊成一张网）。加法混合下颜色暗就是
         透明，所以不需要真正的 alpha 顶点色 —— LineBasicMaterial 的顶点色
         只有 RGB，本来也给不了 alpha。 */
      vertexColors: true,
      depthWrite: false, blending: THREE.AdditiveBlending
    }));
    skyGroup.add(skyLines);

    /* 每个星座的中心方向 + 最亮成员星等，给屏幕上的名字用。

       中心取成员方向的**向量平均**再单位化 —— 球面上的中心不能用经纬度各自
       平均，跨 0° 经线的那几个会飞到对面去。同一个下标会在多条折线里重复
       出现（折线是从作者数据里原样切的段），所以先去重再加：不然出现次数
       多的那颗星会把中心往自己那边拽。最亮成员留着给标签排序 —— 否则一个
       5 等的小星座正对着屏幕中心时，会把大熊座挤掉，而人认得出的正是后者。 */
    skyConstellations = [];
    Object.keys(CONSTELLATION_LINES).forEach(con => {
      const sum = new THREE.Vector3();
      const seen = new Set();
      let mag = 99;
      CONSTELLATION_LINES[con].forEach(line => line.forEach(si => {
        if (seen.has(si)) return;
        seen.add(si);
        const s = SKY_STARS_RAW[si];
        skyPositionOf(s[1], s[2], _v2);
        sum.add(_v2);
        if (s[3] < mag) mag = s[3];
      }));
      if (sum.lengthSq() === 0) return;
      skyConstellations.push({
        dir: sum.normalize(),
        name: SKY_CONSTELLATION_CN[con] || con,
        mag
      });
    });

    /* 壳层**不配拾取球**：1655 个球不划算，而且壳上的位置是投影不是真实
       位置，点它没有意义。它不进 starPickables，而 Raycaster 只测那个数组，
       所以点壳上的星会自然穿透到内层 —— 不需要额外写穿透逻辑。
       别「顺手补上拾取」：真补了，壳星没有 data.radius，focusDistanceOf 会
       算出 NaN 灌进 camera.position，整个画面会黑掉。 */
    skyGroup.updateMatrixWorld(true);
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

    /* 内层假星场在恒星模式必须藏起来。理由加了天球壳之后变了：原先是因为
       「真星最远才 125 单位，而假星铺在 420–900，会混进同一片天区」；
       现在壳层本身就是真实星空的投影，再叠 2600 个随机假星上去，
       743 条星座线就淹没在噪点里了。外层那圈银河带留着当深空底。 */
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

    /* 天球壳的标注。它只在恒星模式有意义 —— 太阳系那边压根没有壳。
       「从太阳看出去」这几个字不是修辞：壳上的位置是从原点投影的，
       而相机永远在原点之外，所以两层对不上是必然的，不是画错了。 */
    if (dom.listNote) dom.listNote.hidden = mode !== 'star';

    /* 星座线和轨道线两只按钮在任一模式下**只出现一个**：恒星模式露星座线，
       太阳系露轨道线。轨道线那圈挂在 worldSolar 里，恒星模式下它跟着一起
       藏了，按钮留着也是按下去毫无反应 —— 那比没有按钮更让人以为坏了。 */
    if (dom.btnConstel) {
      dom.btnConstel.hidden = mode !== 'star';
      dom.btnConstel.classList.toggle('is-on', state.showSky);
    }
    if (dom.btnOrbits) dom.btnOrbits.hidden = mode === 'star';
    if (skyGroup) skyGroup.visible = state.showSky;
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
      /* 那条银河带在恒星模式停下。它铺在 900–1700、y 按 0.55 压扁 ——
         压的是天赤道面，而真银河在人马座方向、和赤道面差着约 60°。
         内层 141 颗太稀疏，这个错一直没暴露；壳上 1655 颗会第一次把
         真的银河带画出来，两条带子差着角度一起转就露馅了。 */
      if (state.mode === 'solar') starFieldFar.rotation.y -= 0.0018 * dt;
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

  /* ============================================================
     十五之二、天球壳的每帧维护
     ============================================================ */

  /* 两件事：让屏幕边缘的星座线淡出、把星座名贴到屏幕上。放在一起是因为
     两者共用同一个判据 ——「这个方向落在屏幕的什么位置」—— 分开写会各算
     一遍坐标变换，调阈值时还容易只改一处。 */

  /* 判据是 **r = 归一化屏幕半径**：0 是屏幕正中，1 是屏幕的四条边。
     注意它是「四条边同时到 1」，也就是在 16:9 上呈椭圆 —— 这才是对的。
     要是用「离相机中心多少度」那种圆锥判据，同一个角度在宽屏上只压得住
     上下两边，左右两边一点没动，而「像盖了层网」主要就是左右两边糊。

     rIn 以内满亮、rOut 以外压到 floor，中间走 smoothstep。换算成角度
     （fov 52°、16:9）：rIn 0.40 约合垂直 ±11°、水平 ±16°；rOut 0.95 约合
     垂直 ±25°、水平 ±35°，基本贴到屏幕边。 */
  const FADE_R_IN  = 0.40;
  const FADE_R_OUT = 0.95;
  /* 地板压到 0.04 是量出来的，不是拍的：末端那道 gamma 是 pow(x, 0.41666)，
     它把小值往上抬 —— 线性 0.12 出来是**感知上的 40%**，根本不是「退成暗纹」，
     边缘照旧是亮的（第一版就是这么翻的车）。要感知降到两成，线性得压到 0.02
     那个量级。

     代价是 8 位量化：composer 的 render target 是 RGBAFormat + 缺省的
     UnsignedByteType，而线满亮时的线性值只有 (0.044, 0.188, 0.217) —— 系数
     到 0.04 附近 R 通道就会被量化成 0。不过 R 只占这条线的一成，掉到 0 之后
     是 (0, 2, 4) 这种极暗的青，肉眼分不出来；真正会看出来的是「星座在屏幕上
     移动时亮度一档一档地跳」，而 0.04 这一档的台阶（G 从 1 到 2）在 sRGB 上
     是 22 → 30，很轻微。 */
  const FADE_FLOOR = 0.04;

  /* 标签的露面门槛，也是 r：只在屏幕中心这一块之内才出名字。和线条共用
     同一个 r，线和它的名字才会一起亮一起灭，不会出现屏幕上写着猎户座、
     猎户座的线却是暗的那种自相矛盾。 */
  const LABEL_R   = 0.68;
  const LABEL_MAX = 8;
  /* 贪心去重用的占位框：中文三字在 11px 下约 60px 宽，留点余量 */
  const LABEL_W = 78;
  const LABEL_H = 20;
  /* 窄屏（竖屏手机那一档）左右两栏就把画面吃得差不多了，名字再铺上去只会
     盖住星空本身。少给几个。 */
  const LABEL_MAX_NARROW = 4;
  const NARROW_W = 700;

  const _camPos  = new THREE.Vector3(NaN, NaN, NaN);
  const _camQuat = new THREE.Quaternion(NaN, NaN, NaN, NaN);
  /* 标签的候选池：一次按星座数建好，逐帧复用。每帧现建几十个小对象也能跑，
     但那是纯垃圾 —— 这些字段连清都不用清，全都会被覆写。 */
  const _labelPool = [];
  const _labelHits = [];

  /* projectToScreen 的输出。放模块级而不是返回对象：每帧要算几十次，
     返回对象就是每帧几十个短命对象。 */
  let _skyX = 0, _skyY = 0, _skyR = Infinity;

  /** 两端导数为零的平滑插值，免得淡出的边界上出现一条硬边 */
  function smoothstep(e0, e1, x) {
    const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
    return t * t * (3 - 2 * t);
  }

  /** 世界坐标 -> 屏幕。结果落在 _skyX / _skyY / _skyR（r 是归一化屏幕半径） */
  function projectToScreen(worldPoint, tanHalfX, tanHalfY) {
    /* 相机坐标系里 z < 0 才是前方。这里刻意不用 Vector3.project()：它内部
       就是两个矩阵乘、中间除以 w，对相机背后的点**不设防** —— w < 0 会把
       x、y 翻转符号，于是背后的方向看起来「落在屏幕里」，标签会镜像到正前方。 */
    _v1.copy(worldPoint).sub(camera.position).applyMatrix4(camera.matrixWorldInverse);
    if (_v1.z > -1e-4) { _skyR = Infinity; return; }
    const invZ = -1 / _v1.z;
    const nx = _v1.x * invZ / tanHalfX;
    const ny = _v1.y * invZ / tanHalfY;
    _skyR = Math.sqrt(nx * nx + ny * ny);
    /* 用 window.innerWidth 而不是 canvas.width：后者是设备像素，pixelRatio
       为 2 时差一倍。 */
    _skyX = (0.5 + 0.5 * nx) * window.innerWidth;
    _skyY = (0.5 - 0.5 * ny) * window.innerHeight;
  }

  function hideSkyLabels() {
    if (skyLabelEls) skyLabelEls.forEach(el => { el.hidden = true; });
  }

  /* 面板是压在星空上的深色块（层级 50 起，标签在 25）。名字落到它们底下只
     会露出半个字 ——「御夫座」变成「夫座」，看着像坏了。与其半遮半掩，不如
     整个不要：那个星座拖到画面中间来就会有名字。

     判据是「标签的框和面板的框相不相交」，不是「x 在不在两栏之间」。旧的
     写法假设左栏是贴着左边缘的一条竖栏，可窄屏（≤820px）下它被收成了屏幕
     底部一条署名空壳（见 style.css 的媒体查询）—— 占的 x 区间还是老样子，
     于是「两栏」之间的缝只剩 3px，窄屏上一个名字都出不来。

     标题也一起挡：画面左上角就它会压字。

     面板是响应式的，所以每帧量一次。量在写 style 之前，不会触发强制重排。 */
  let _panelEls = null;
  let _panelBoxes = null;

  function measurePanels() {
    if (!_panelEls) {
      _panelEls = ['.hud-left', '.hud-right', '.hud-title']
        .map(sel => document.querySelector(sel));
    }
    _panelBoxes = _panelEls
      .map(el => el && el.getBoundingClientRect())
      .filter(r => r && r.width > 0 && r.height > 0);
  }

  /* 以投影点为中心、2·halfW 宽 LABEL_H 高的那个框，压在哪块面板上了没有 */
  function blockedByPanel(cx, cy, halfW) {
    const l = cx - halfW, r = cx + halfW;
    const t = cy - LABEL_H * 0.5, b = cy + LABEL_H * 0.5;
    for (let i = 0; i < _panelBoxes.length; i++) {
      const p = _panelBoxes[i];
      if (l < p.right && r > p.left && t < p.bottom && b > p.top) return true;
    }
    return false;
  }

  function updateSkyLayer() {
    /* 显隐只在这里判一处。applyMode 和「星座线」按钮的回调都只管改 state，
       不碰 DOM —— 那种「两个地方各改一半」的写法，漏一处就是一个只在特定
       操作顺序下才现形的 bug。

       switching 也算进来：applyMode 是换场动画**走到一半**才调的，在那之前
       相机已经拉着飞出去了，而标签是 DOM、不在 worldStars 底下，
       worldStars.visible = false 收不走它。 */
    const show = state.booted && !state.switching && state.mode === 'star'
                 && state.showSky && skyLines && skyGroup && skyGroup.visible;
    if (dom.skyLabels) dom.skyLabels.hidden = !show;
    if (!show) { hideSkyLabels(); return; }

    if (!skyLabelEls) {
      /* DOM 池：一次建满，之后每帧只改文字和 transform。每帧重建元素会一直
         触发布局，标签本身还会一闪一闪的。 */
      skyLabelEls = [];
      for (let i = 0; i < LABEL_MAX; i++) {
        const el = document.createElement('span');
        el.className = 'sky-label';
        el.hidden = true;
        dom.skyLabels.appendChild(el);
        skyLabelEls.push(el);
      }
    }
    if (!_labelPool.length) {
      skyConstellations.forEach(() => _labelPool.push({ name: '', score: 0, x: 0, y: 0 }));
    }

    /* matrixWorldInverse 只有 Camera 版的 updateMatrixWorld 会同步（Object3D
       版不管它），而 renderer 要到本帧末尾才渲染。controls.update() 刚改完
       位姿 —— 这里不补一次，这一帧读到的全是上一帧的相机。 */
    camera.updateMatrixWorld();

    /* 相机位姿一个字都没变就整块跳过。画面静止时这里是空转。
       这里刻意不照抄悬停检测那套「隔 0.05s」：那是为了省射线求交，而这块
       是纯算术 —— 更关键的是阻尼松手之后相机还要滑半秒，20Hz 会让标签
       一格一格地跳，而标签是钉在点上的，跳一格就是几十像素。 */
    if (_camPos.distanceToSquared(camera.position) < 1e-4 &&
        Math.abs(1 - Math.abs(_camQuat.dot(camera.quaternion))) < 1e-7) return;
    _camPos.copy(camera.position);
    _camQuat.copy(camera.quaternion);

    const tanHalfY = Math.tan(camera.fov * Math.PI / 360);
    const tanHalfX = tanHalfY * camera.aspect;
    const labelMax = window.innerWidth < NARROW_W ? LABEL_MAX_NARROW : LABEL_MAX;
    measurePanels();

    /* ---- 一、逐顶点算淡出系数 ----

       为什么不是「一个星座一个系数」：那样代码更短，还能保证线和它的名字
       一起亮一起灭，但大星座会露馅 —— 长蛇座跨 66°、波江座 37°，中心还在
       屏幕正中时尾巴早甩到屏幕边上去了，整条按中心的系数亮着，边角那截
       一点没压住。而「边角不要糊成一张网」正是这一趟要治的东西。

       代价是「有线的星座不一定有名字」：星座中心甩出视野外时名字不出现，
       可它伸进屏幕里的那截线还是亮的。这在跨度超过视野的那几个（长蛇座）
       上会碰到，接受 —— 名字要跟着中心走，中心不在屏幕里就没地方放。 */
    const pos = skyLines.geometry.attributes.position.array;
    const col = skyLines.geometry.attributes.color.array;
    const e = camera.matrixWorldInverse.elements;   // 列主序
    const vN = pos.length / 3;

    for (let i = 0; i < vN; i++) {
      const i3 = i * 3;
      const px = pos[i3], py = pos[i3 + 1], pz = pos[i3 + 2];
      /* 直接做矩阵乘，不走 Vector3.applyMatrix4 —— 每帧一千多次，省掉
         临时对象的来回拷。w 恒为 1（刚体变换），不用除。 */
      const ex = e[0] * px + e[4] * py + e[8]  * pz + e[12];
      const ey = e[1] * px + e[5] * py + e[9]  * pz + e[13];
      const ez = e[2] * px + e[6] * py + e[10] * pz + e[14];

      /* 相机背后的顶点（ez >= 0）直接给地板。反正看不见，但得给个值 ——
         留着上一帧的系数会在转头时闪。 */
      let f = FADE_FLOOR;
      if (ez < -1e-4) {
        const invZ = -1 / ez;
        const nx = ex * invZ / tanHalfX;
        const ny = ey * invZ / tanHalfY;
        const r = Math.sqrt(nx * nx + ny * ny);
        const p = 1 - smoothstep(FADE_R_IN, FADE_R_OUT, r);
        /* 三次方不是为了「更平滑」，是补末端的 gamma：solarisEncodeSRGB 是
           pow(x, 0.41666)，线性乘 0.5 出来眼睛看到的还有 0.73 —— 直接拿 p 当
           系数，淡出会弱到看不出来，然后就会一路把阈值往极端调，连中心也糊。
           平方补掉一半，三次方才是「中环就已经明显退下去」的手感。 */
        f = FADE_FLOOR + (1 - FADE_FLOOR) * p * p * p;
      }
      col[i3] = col[i3 + 1] = col[i3 + 2] = f;
    }
    skyLines.geometry.attributes.color.needsUpdate = true;

    /* ---- 二、星座名：位置照旧按中心算 ---- */
    _labelHits.length = 0;
    let slot = 0;

    for (let i = 0; i < skyConstellations.length; i++) {
      const c = skyConstellations[i];

      projectToScreen(_v2.copy(c.dir).multiplyScalar(SKY_RADIUS), tanHalfX, tanHalfY);
      if (_skyR > LABEL_R) continue;
      const p = 1 - smoothstep(FADE_R_IN, FADE_R_OUT, _skyR);

      /* 名字的宽度在这里得估：还没写进 DOM，量不到。中文在 11px 字号、
         0.14em 字距下大约 13px 一个字，两边各 8px 内边距。估大一点无妨 ——
         宁可少出一个名字，也不要露出半个字。 */
      const halfW = (c.name.length * 13 + 18) / 2;
      if (slot < _labelPool.length && !blockedByPanel(_skyX, _skyY, halfW)) {
        const hit = _labelPool[slot++];
        hit.name = c.name;
        /* 排序分数 = 正对程度 + 一点星等权重。只看正对程度的话，一个 5 等的
           小星座正对着屏幕中心时会把大熊座挤掉，而人认得出的正是后者。 */
        hit.score = 0.7 * p + 0.3 * Math.min(Math.max((3.0 - c.mag) / 3.5, 0), 1);
        hit.x = _skyX;
        hit.y = _skyY;
        _labelHits.push(hit);
      }
    }

    _labelHits.sort((a, b) => b.score - a.score);

    /* 贪心去重：两个名字挨得太近会叠成一团，谁也看不清。按分数从高到低
       占位，跟已经选中的撞上就直接不要它。 */
    let n = 0;
    for (let i = 0; i < _labelHits.length && n < labelMax; i++) {
      const hit = _labelHits[i];
      let clash = false;
      for (let j = 0; j < n; j++) {
        const k = _labelHits[j];
        if (Math.abs(hit.x - k.x) < LABEL_W && Math.abs(hit.y - k.y) < LABEL_H) {
          clash = true;
          break;
        }
      }
      if (clash) continue;
      _labelHits[n++] = hit;   // 就地往前挪，hit 已经取出来了，覆盖不到它
    }

    for (let i = 0; i < skyLabelEls.length; i++) {
      const el = skyLabelEls[i];
      if (i >= n) { el.hidden = true; continue; }
      const hit = _labelHits[i];
      if (el.textContent !== hit.name) el.textContent = hit.name;
      /* transform 而不是 left/top：后者每帧都要重算布局。translate(-50%,-50%)
         是让元素以自身中心对齐这个点 —— 百分比相对的是元素自己的尺寸。 */
      el.style.transform =
        'translate(' + Math.round(hit.x) + 'px,' + Math.round(hit.y) + 'px) translate(-50%,-50%)';
      el.hidden = false;
    }
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
    /* 天球壳的淡出和星座名。放在 controls.update() 之后：它读相机位姿。
       不隔帧 —— 理由见 updateSkyLayer 里那段。 */
    updateSkyLayer();

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

    // 轨道线（太阳系的）
    dom.btnOrbits.addEventListener('click', () => {
      state.showOrbits = !state.showOrbits;
      dom.btnOrbits.classList.toggle('is-on', state.showOrbits);
      orbitLines.forEach(l => (l.visible = state.showOrbits));
    });

    /* 星座线（只在恒星模式露面）。切的是整个天球壳，不只是线 ——
       壳和线是一体的，留一层没有线的空壳没什么意义。

       刻意不复用轨道线那只按钮：那样得在 handler 里按模式分流、在 applyMode
       里同步文案和 is-on、还要记住两套状态，三处都可能出岔子；而"换场后
       按钮文案没跟上"这类 bug 只在特定操作顺序下才现形。多一个按钮，
       回归面小得多。 */
    dom.btnConstel.addEventListener('click', () => {
      state.showSky = !state.showSky;
      dom.btnConstel.classList.toggle('is-on', state.showSky);
      if (skyGroup) skyGroup.visible = state.showSky;
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
      'list-credit', 'list-note', 'btn-constel', 'sky-labels',
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
    buildSkyShell();
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
      /* 天球壳。skyGroup 是壳星那 4 个 Points 的父节点，skyLineMesh 是那 743 段
         合一之后的 LineSegments —— 断言要能数出「所有顶点都在半径 300 的球面上」
         和「每段的两端就是它引用的那两颗星的位置」。 */
      skyStars: SKY_STARS_RAW, skyLines: CONSTELLATION_LINES,
      skyGroup, skyLineMesh: skyLines,
      SKY_RADIUS, SKY_MAG_BUCKETS, skyPositionOf, skyColorFromBV,
      /* 星座的中心/中文名/顶点区间，淡出和标签都靠它。
         断言要能核对「88 个键一个不缺」「区间首尾相接铺满整个 buffer」。 */
      skyConstellations, skyConNames: SKY_CONSTELLATION_CN,
      /* 淡出的参数和当前标签。skyUpdate 是给断言用的强制刷新：正常路径上
         「相机没动就跳过」，而脚本改完相机立刻断言，不强制跑一次读到的
         还是上一帧的值。 */
      skyFade: { rIn: FADE_R_IN, rOut: FADE_R_OUT, floor: FADE_FLOOR,
                 labelR: LABEL_R, labelMax: LABEL_MAX,
                 labelW: LABEL_W, labelH: LABEL_H },
      skyUpdate: () => {
        _camPos.set(NaN, NaN, NaN);
        _camQuat.set(NaN, NaN, NaN, NaN);
        updateSkyLayer();
      },
      skyProject: projectToScreen, skyLabelEls: () => skyLabelEls,
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
