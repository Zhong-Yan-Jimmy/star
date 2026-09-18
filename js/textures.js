/* ============================================================
   SOLARIS · 程序化纹理生成
   全部纹理由噪声算法实时算出，不依赖任何外部图片资源
   采样方式：在球面上取 3D 噪声，保证经度接缝处完全无缝
   ============================================================ */

const TexGen = (function () {

  /* ---------------- 基础工具 ---------------- */

  const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const mix = (c1, c2, t) => [lerp(c1[0], c2[0], t), lerp(c1[1], c2[1], t), lerp(c1[2], c2[2], t)];

  function smoothstep(e0, e1, x) {
    const t = clamp01((x - e0) / (e1 - e0));
    return t * t * (3 - 2 * t);
  }

  /* ---------------- 噪声 ---------------- */

  function hash3(x, y, z, seed) {
    let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) +
            Math.imul(z | 0, 2147483647) + Math.imul(seed | 0, 1274126177);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967295;
  }

  function noise3(x, y, z, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = xf * xf * (3 - 2 * xf);
    const v = yf * yf * (3 - 2 * yf);
    const w = zf * zf * (3 - 2 * zf);

    const n000 = hash3(xi, yi, zi, seed),         n100 = hash3(xi + 1, yi, zi, seed);
    const n010 = hash3(xi, yi + 1, zi, seed),     n110 = hash3(xi + 1, yi + 1, zi, seed);
    const n001 = hash3(xi, yi, zi + 1, seed),     n101 = hash3(xi + 1, yi, zi + 1, seed);
    const n011 = hash3(xi, yi + 1, zi + 1, seed), n111 = hash3(xi + 1, yi + 1, zi + 1, seed);

    const x00 = n000 + (n100 - n000) * u, x10 = n010 + (n110 - n010) * u;
    const x01 = n001 + (n101 - n001) * u, x11 = n011 + (n111 - n011) * u;
    const y0 = x00 + (x10 - x00) * v,     y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }

  function noise1(x, seed) {
    const xi = Math.floor(x), xf = x - xi;
    const u = xf * xf * (3 - 2 * xf);
    const a = hash3(xi, 0, 0, seed), b = hash3(xi + 1, 0, 0, seed);
    return a + (b - a) * u;
  }

  /** 分形布朗运动：叠加多个频率的噪声，得到自然的不规则感 */
  function fbm3(x, y, z, seed, octaves, gain, lac) {
    octaves = octaves || 5; gain = gain || 0.5; lac = lac || 2.0;
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += amp * noise3(x * f, y * f, z * f, seed + i * 131);
      norm += amp;
      amp *= gain;
      f *= lac;
    }
    return sum / norm;
  }

  /** 脊状噪声：产生山脉、沟壑一类的锐利结构 */
  function ridged3(x, y, z, seed, octaves) {
    octaves = octaves || 4;
    let amp = 0.5, f = 1, sum = 0, norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(noise3(x * f, y * f, z * f, seed + i * 137) * 2 - 1);
      sum += amp * n * n;
      norm += amp;
      amp *= 0.5;
      f *= 2;
    }
    return sum / norm;
  }

  /* ---------------- 画布与球面采样 ---------------- */

  /**
   * 逐像素生成一张等距圆柱投影（equirectangular）纹理。
   * sampler(px,py,pz, u,v, out) —— px/py/pz 是球面单位向量，保证无缝
   */
  function buildCanvas(width, height, sampler) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(width, height);
    const data = img.data;
    const out = [0, 0, 0, 255];

    for (let j = 0; j < height; j++) {
      const v = (j + 0.5) / height;
      const lat = (0.5 - v) * Math.PI;
      const cl = Math.cos(lat), sl = Math.sin(lat);
      for (let i = 0; i < width; i++) {
        const u = (i + 0.5) / width;
        const lon = u * Math.PI * 2;
        out[0] = out[1] = out[2] = 0; out[3] = 255;
        sampler(cl * Math.cos(lon), sl, cl * Math.sin(lon), u, v, out);
        const k = (j * width + i) * 4;
        data[k] = out[0]; data[k + 1] = out[1]; data[k + 2] = out[2]; data[k + 3] = out[3];
      }
    }
    ctx.putImageData(img, 0, 0);
    return canvas;
  }

  /** 在纹理上叠加陨石坑；自动处理左右环绕接缝 */
  function stampCraters(ctx, w, h, count, opts) {
    const minR = opts.minR || 2, maxR = opts.maxR || 14;
    const pow = opts.pow || 3;          // 指数越大，小坑越多
    const dark = opts.dark || '40,34,30';
    const light = opts.light || '225,218,208';
    const strength = opts.strength == null ? 1 : opts.strength;

    for (let i = 0; i < count; i++) {
      const cx = Math.random() * w;
      // 纬度按 sin 分布，避免极区过度堆积
      const t = Math.random();
      const cy = (0.5 - Math.asin(t * 2 - 1) / Math.PI) * h;
      const r = minR + Math.pow(Math.random(), pow) * (maxR - minR);

      // 坑太靠近两极就跳过（会被严重拉伸）
      if (cy < r * 0.5 || cy > h - r * 0.5) continue;

      drawCrater(ctx, cx, cy, r, w, h, dark, light, strength);
    }
  }

  function drawCrater(ctx, x, y, r, w, h, dark, light, strength) {
    // 中心为暗（坑底），外圈为亮（抛出物毯），最外渐隐
    const paint = (px) => {
      const g = ctx.createRadialGradient(px, y, 0, px, y, r * 1.45);
      g.addColorStop(0.00, 'rgba(' + dark + ',' + (0.55 * strength) + ')');
      g.addColorStop(0.52, 'rgba(' + dark + ',' + (0.34 * strength) + ')');
      g.addColorStop(0.70, 'rgba(' + light + ',' + (0.26 * strength) + ')');
      g.addColorStop(0.86, 'rgba(' + light + ',' + (0.10 * strength) + ')');
      g.addColorStop(1.00, 'rgba(' + light + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(px, y, r * 1.45, 0, Math.PI * 2);
      ctx.fill();
    };
    paint(x);
    if (x - r * 1.45 < 0) paint(x + w);      // 左边界外 → 右侧补一份
    if (x + r * 1.45 > w) paint(x - w);      // 右边界外 → 左侧补一份
  }

  /** 在纹理上叠加一个椭圆斑块（大红斑、大暗斑之类），同样处理环绕 */
  function stampSpot(ctx, w, h, cu, cv, rx, ry, stops) {
    const x = cu * w, y = cv * h, R = rx * w, Ry = ry * h;
    const paint = (px) => {
      ctx.save();
      ctx.translate(px, y);
      ctx.scale(1, Ry / R);
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      stops.forEach(([p, c]) => g.addColorStop(p, c));
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, R, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    paint(x);
    if (x - R < 0) paint(x + w);
    if (x + R > w) paint(x - w);
  }

  /* ---------------- 各天体的表面算法 ---------------- */

  const SAMPLERS = {

    /* 太阳：颗粒状对流元胞 + 亮斑，暖白偏黄 */
    sun(px, py, pz, u, v, out) {
      const base = fbm3(px * 3.5, py * 3.5, pz * 3.5, 11, 5);
      const cells = ridged3(px * 17, py * 17, pz * 17, 5, 3);
      const s = clamp01(base * 0.68 + cells * 0.50);
      out[0] = lerp(216, 255, s);
      out[1] = lerp(112, 243, Math.pow(s, 1.05));
      out[2] = lerp(16, 148, Math.pow(s, 2.4));
      out[3] = 255;
    },

    /* 水星：灰褐色，遍布陨石坑与暗色平原 */
    mercury(px, py, pz, u, v, out) {
      const base = fbm3(px * 2.2, py * 2.2, pz * 2.2, 21, 6);
      const fine = fbm3(px * 11, py * 11, pz * 11, 55, 4);
      const mare = fbm3(px * 1.4, py * 1.4, pz * 1.4, 88, 3);
      let g = 0.46 + base * 0.28 + fine * 0.13;
      g *= lerp(1.0, 0.74, smoothstep(0.54, 0.76, mare));
      const c = g * 255;
      out[0] = c * 1.03; out[1] = c * 0.965; out[2] = c * 0.90; out[3] = 255;
    },

    /* 金星：厚重的硫酸云，水平拉伸的黄白色涡流 */
    venus(px, py, pz, u, v, out) {
      const band = fbm3(px * 1.7, py * 7.5, pz * 1.7, 31, 6);
      const swirl = fbm3(px * 5.0, py * 5.0, pz * 5.0, 63, 4);
      const t = clamp01(band * 0.72 + swirl * 0.36);
      out[0] = lerp(202, 255, t);
      out[1] = lerp(168, 241, t);
      out[2] = lerp(102, 196, t);
      out[3] = 255;
    },

    /* 地球：海洋 / 大陆 / 沙漠带 / 极冠 */
    earth(px, py, pz, u, v, out) {
      const cont = fbm3(px * 1.9, py * 1.9, pz * 1.9, 101, 6);
      const detail = fbm3(px * 7.5, py * 7.5, pz * 7.5, 133, 5);
      const h = cont * 0.78 + detail * 0.22;
      const lat = Math.abs(py);

      let col;
      if (h > 0.52) {
        const elev = clamp01((h - 0.52) / 0.28);
        col = mix([82, 122, 58], [152, 134, 80], smoothstep(0.0, 0.45, elev));
        col = mix(col, [122, 118, 112], smoothstep(0.52, 0.86, elev));
        // 南北纬 20°~35° 的副热带沙漠带
        const desert = smoothstep(0.28, 0.40, lat) * (1 - smoothstep(0.50, 0.62, lat));
        col = mix(col, [198, 172, 112], desert * 0.7);
      } else {
        const depth = clamp01((0.52 - h) / 0.30);
        col = mix([48, 118, 182], [5, 22, 70], smoothstep(0.04, 0.62, depth));
      }
      // 极地冰盖
      col = mix(col, [241, 248, 255], smoothstep(0.855, 0.95, lat + (detail - 0.5) * 0.13));

      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 地球云层：独立一层带 alpha 的半透明球 */
    earthClouds(px, py, pz, u, v, out) {
      const c1 = fbm3(px * 2.4, py * 2.4, pz * 2.4, 201, 6);
      const c2 = fbm3(px * 6.5, py * 6.5, pz * 6.5, 211, 5);
      let d = c1 * 0.72 + c2 * 0.30;
      d += 0.055 * Math.cos(py * Math.PI * 2) + 0.05 * Math.cos(py * Math.PI * 6);
      const a = smoothstep(0.50, 0.75, d);
      out[0] = 255; out[1] = 255; out[2] = 255;
      out[3] = a * 235;
    },

    /* 火星：锈红色，深色高原，极冠 */
    mars(px, py, pz, u, v, out) {
      const base = fbm3(px * 2.3, py * 2.3, pz * 2.3, 301, 6);
      const detail = fbm3(px * 8.5, py * 8.5, pz * 8.5, 311, 5);
      const t = clamp01(base * 0.70 + detail * 0.32);
      const dark = fbm3(px * 1.5, py * 1.5, pz * 1.5, 322, 3);
      const canyon = ridged3(px * 4.0, py * 4.0, pz * 4.0, 333, 3);

      let col = mix([168, 82, 46], [234, 152, 96], t);
      col = mix(col, [118, 58, 36], smoothstep(0.56, 0.80, dark) * 0.78);
      col = mix(col, [96, 46, 30], smoothstep(0.72, 0.95, canyon) * 0.35);

      const lat = Math.abs(py);
      col = mix(col, [248, 246, 240], smoothstep(0.90, 0.975, lat + (detail - 0.5) * 0.07));

      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 木星：强烈的东西向条带 + 湍流 */
    jupiter(px, py, pz, u, v, out) {
      const turb = fbm3(px * 2.0, py * 5.5, pz * 2.0, 401, 5);
      const fine = fbm3(px * 7.0, py * 18.0, pz * 7.0, 411, 4);
      const lat = py + (turb - 0.5) * 0.115;

      let band = (Math.sin(lat * Math.PI * 11.0) * 0.5 + 0.5) * 0.60
               + (Math.sin(lat * Math.PI * 25.0) * 0.5 + 0.5) * 0.22
               + fine * 0.34;
      band = clamp01(band);

      let col = mix([128, 84, 54], [196, 150, 104], smoothstep(0.12, 0.50, band));
      col = mix(col, [243, 228, 200], smoothstep(0.50, 0.78, band));
      // 两极偏灰蓝
      col = mix(col, [146, 144, 150], smoothstep(0.58, 0.96, Math.abs(py)) * 0.5);

      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 土星：比木星更柔和、更金黄的条带 */
    saturn(px, py, pz, u, v, out) {
      const turb = fbm3(px * 1.8, py * 5.0, pz * 1.8, 501, 5);
      const fine = fbm3(px * 6.0, py * 15.0, pz * 6.0, 511, 4);
      const lat = py + (turb - 0.5) * 0.085;

      let band = (Math.sin(lat * Math.PI * 9.0) * 0.5 + 0.5) * 0.55
               + (Math.sin(lat * Math.PI * 21.0) * 0.5 + 0.5) * 0.18
               + fine * 0.36;
      band = clamp01(band);

      let col = mix([186, 148, 88], [226, 198, 138], smoothstep(0.15, 0.55, band));
      col = mix(col, [248, 238, 210], smoothstep(0.55, 0.82, band));
      col = mix(col, [176, 158, 126], smoothstep(0.62, 0.98, Math.abs(py)) * 0.45);

      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 天王星：甲烷造成的青蓝色，极其平滑 */
    uranus(px, py, pz, u, v, out) {
      const n = fbm3(px * 1.5, py * 3.6, pz * 1.5, 601, 4);
      const t = clamp01(n * 0.55 + (Math.sin(py * Math.PI * 7.0) * 0.5 + 0.5) * 0.45);
      let col = mix([142, 214, 224], [198, 244, 248], t);
      col = mix(col, [176, 232, 238], smoothstep(0.5, 1.0, Math.abs(py)) * 0.4);
      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 海王星：深蓝，条带更明显，带一个暗斑 */
    neptune(px, py, pz, u, v, out) {
      const turb = fbm3(px * 2.2, py * 5.0, pz * 2.2, 701, 5);
      const lat = py + (turb - 0.5) * 0.10;
      let band = (Math.sin(lat * Math.PI * 8.0) * 0.5 + 0.5) * 0.5 + turb * 0.5;
      band = clamp01(band);
      let col = mix([28, 58, 176], [92, 138, 232], smoothstep(0.2, 0.72, band));
      col = mix(col, [186, 214, 246], smoothstep(0.80, 0.98, band) * 0.55);
      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 冥王星：棕褐色，带一片明亮的氮冰平原 */
    pluto(px, py, pz, u, v, out) {
      const base = fbm3(px * 3.0, py * 3.0, pz * 3.0, 801, 6);
      const detail = fbm3(px * 9.0, py * 9.0, pz * 9.0, 811, 4);
      const plain = fbm3(px * 2.0, py * 2.0, pz * 2.0, 822, 3);
      let col = mix([108, 84, 68], [206, 184, 156], clamp01(base * 0.72 + detail * 0.30));
      col = mix(col, [244, 238, 224], smoothstep(0.52, 0.72, plain) * 0.9);
      out[0] = col[0]; out[1] = col[1]; out[2] = col[2]; out[3] = 255;
    },

    /* 月球：灰色月海 + 密集陨石坑 */
    moon(px, py, pz, u, v, out) {
      const base = fbm3(px * 2.6, py * 2.6, pz * 2.6, 901, 6);
      const fine = fbm3(px * 12, py * 12, pz * 12, 911, 4);
      const mare = fbm3(px * 1.6, py * 1.6, pz * 1.6, 922, 3);
      let g = 0.50 + base * 0.26 + fine * 0.12;
      g *= lerp(1.0, 0.62, smoothstep(0.50, 0.72, mare));
      const c = g * 255;
      out[0] = c * 1.0; out[1] = c * 0.99; out[2] = c * 0.96; out[3] = 255;
    },

    /* 火卫一类：极暗、粗糙、形状不规则的小天体 */
    asteroid(px, py, pz, u, v, out) {
      const base = fbm3(px * 5.0, py * 5.0, pz * 5.0, 1001, 5);
      const fine = fbm3(px * 16, py * 16, pz * 16, 1011, 4);
      const g = (0.34 + base * 0.30 + fine * 0.20) * 255;
      out[0] = g * 1.02; out[1] = g * 0.94; out[2] = g * 0.86; out[3] = 255;
    }
  };

  /* 需要额外用 2D 画布叠加陨石坑的天体 */
  const CRATER_OPTS = {
    mercury: { count: 340, minR: 2, maxR: 17, pow: 3.0, dark: '38,32,28', light: '232,225,215', strength: 1.0 },
    moon:    { count: 420, minR: 2, maxR: 20, pow: 3.0, dark: '26,26,26', light: '240,240,238', strength: 1.15 },
    mars:    { count: 190, minR: 2, maxR: 15, pow: 3.4, dark: '52,24,14', light: '250,206,170', strength: 0.75 },
    asteroid:{ count: 200, minR: 2, maxR: 13, pow: 2.6, dark: '18,16,14', light: '200,190,175', strength: 1.0 },
    venus:   { count: 90,  minR: 3, maxR: 14, pow: 3.4, dark: '140,110,60', light: '255,246,220', strength: 0.30 },
    pluto:   { count: 120, minR: 2, maxR: 12, pow: 3.2, dark: '48,36,28', light: '250,246,236', strength: 0.55 }
  };

  /* 需要叠加椭圆形斑块的天体 */
  const SPOT_OPTS = {
    jupiter: [
      { u: 0.31, v: 0.635, rx: 0.085, ry: 0.052, stops: [
        [0.00, 'rgba(186,74,42,0.94)'], [0.42, 'rgba(206,104,64,0.80)'],
        [0.74, 'rgba(224,158,120,0.40)'], [1.00, 'rgba(224,190,160,0)']] },
      { u: 0.72, v: 0.44, rx: 0.045, ry: 0.030, stops: [
        [0.00, 'rgba(244,236,220,0.72)'], [0.60, 'rgba(246,240,226,0.32)'], [1.00, 'rgba(246,240,226,0)']] }
    ],
    neptune: [
      { u: 0.24, v: 0.62, rx: 0.070, ry: 0.048, stops: [
        [0.00, 'rgba(12,26,96,0.80)'], [0.55, 'rgba(20,44,140,0.44)'], [1.00, 'rgba(24,54,160,0)']] }
    ],
    mars: [
      { u: 0.55, v: 0.40, rx: 0.150, ry: 0.075, stops: [
        [0.00, 'rgba(92,44,26,0.55)'], [0.60, 'rgba(120,66,40,0.26)'], [1.00, 'rgba(140,84,54,0)']] }
    ]
  };

  /* ---------------- 对外接口 ---------------- */

  const cache = {};

  /**
   * 生成（或取缓存）某天体的纹理画布
   * @param {string} key 纹理类型
   * @param {number} w 宽度
   * @param {number} h 高度
   */
  function getCanvas(key, w, h) {
    w = w || 1024; h = h || 512;
    const ck = key + '@' + w + 'x' + h;
    if (cache[ck]) return cache[ck];

    const sampler = SAMPLERS[key];
    if (!sampler) return null;

    const canvas = buildCanvas(w, h, sampler);

    if (CRATER_OPTS[key]) {
      const ctx = canvas.getContext('2d');
      stampCraters(ctx, w, h, CRATER_OPTS[key].count, CRATER_OPTS[key]);
    }
    if (SPOT_OPTS[key]) {
      const ctx = canvas.getContext('2d');
      SPOT_OPTS[key].forEach(s => stampSpot(ctx, w, h, s.u, s.v, s.rx, s.ry, s.stops));
    }

    cache[ck] = canvas;
    return canvas;
  }

  /** 包装成 three 纹理 */
  function getTexture(key, w, h) {
    const canvas = getCanvas(key, w, h);
    if (!canvas) return null;
    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.RepeatWrapping;               // 允许经度方向跨边界过滤，消除接缝
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    tex.anisotropy = TexGen.maxAnisotropy || 1;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * 土星环纹理：一维径向分布，含卡西尼缝等主要间隙
   */
  function makeRingTexture(vertical) {
    const w = 1024, h = 16;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(w, h);
    const d = img.data;

    const gaps = vertical
      ? []                                                  // 天王星环更窄更稀薄
      : [
          { at: 0.28, w: 0.020, depth: 0.72 },              // 麦克斯韦缝附近
          { at: 0.62, w: 0.017, depth: 0.95 },              // 卡西尼环缝
          { at: 0.935, w: 0.014, depth: 0.88 }              // 恩克缝
        ];

    for (let i = 0; i < w; i++) {
      const t = i / (w - 1);
      let a = 0.56
            + noise1(t * 42, 7) * 0.30
            + noise1(t * 130, 19) * 0.17
            + noise1(t * 340, 31) * 0.11;

      // 细密的环缝纹理
      a *= 0.82 + 0.18 * noise1(t * 900, 47);

      gaps.forEach(g => {
        a *= 1 - g.depth * Math.exp(-Math.pow((t - g.at) / g.w, 2));
      });

      // 内外边缘柔和渐隐
      a *= smoothstep(0, 0.055, t) * (1 - smoothstep(0.93, 1.0, t));
      a = clamp01(a);

      const col = vertical
        ? mix([150, 196, 210], [206, 236, 244], t)
        : mix([208, 188, 152], [240, 234, 220], t);

      for (let j = 0; j < h; j++) {
        const k = (j * w + i) * 4;
        d[k] = col[0]; d[k + 1] = col[1]; d[k + 2] = col[2]; d[k + 3] = a * 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    return tex;
  }

  /** 径向渐变光晕贴图，用于太阳辉光与星点 */
  // 只保留颜色与衰减指数：旧签名里夹了一个从未被使用的 outer，
  // 调用方按 (color, power) 传参时 power 会落到 outer 上被丢掉，
  // 所有辉光都退化成默认的 2.4，边缘衰减比预期的更陡、更容易量化出硬边。
  function makeGlowTexture(inner, power) {
    const size = 256;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d');
    const img = ctx.createImageData(size, size);
    const d = img.data;
    const c = size / 2;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - c) / c, dy = (y - c) / c;
        const r = Math.sqrt(dx * dx + dy * dy);
        const a = r >= 1 ? 0 : Math.pow(1 - r, power || 2.4);
        const k = (y * size + x) * 4;
        d[k] = inner[0]; d[k + 1] = inner[1]; d[k + 2] = inner[2];
        // 低于 2/255 的 alpha 直接归零。8 位量化会把整片极低 alpha 抹成同一个
        // 1/255，在近乎全黑的背景上，这块"亮度恰好为 1"的平坦区域连同方形
        // sprite 的直边，就成了一道肉眼可见的轮廓。
        d[k + 3] = a < 0.008 ? 0 : clamp01(a) * 255;
      }
    }
    ctx.putImageData(img, 0, 0);

    const tex = new THREE.CanvasTexture(canvas);
    if (THREE.sRGBEncoding !== undefined) tex.encoding = THREE.sRGBEncoding;
    tex.needsUpdate = true;
    return tex;
  }

  return {
    getCanvas: getCanvas,
    getTexture: getTexture,
    makeRingTexture: makeRingTexture,
    makeGlowTexture: makeGlowTexture,
    fbm3: fbm3,
    maxAnisotropy: 1
  };

})();
