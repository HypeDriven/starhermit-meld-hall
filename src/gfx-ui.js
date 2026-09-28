'use strict';
/*
 * Meld Hall — Graphics section of the Settings overlay.
 * Builds the controls into #gfx-section, localizes them (navigator.language;
 * the rest of the game is English), stores choices in settings.graphics and
 * reports every change through onChange so main.js can apply it live.
 */
(function (root, factory) {
  const Gfx = (typeof module !== 'undefined' && module.exports) ? require('./gfx.js') : root.MeldGfx;
  const api = factory(Gfx);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.MeldGfxUI = api;
})(typeof self !== 'undefined' ? self : globalThis, function (Gfx) {

  const EN = {
    title: 'Graphics', quality: 'Quality', auto: 'Auto (detected: {tier})', scale: 'Render scale',
    fromPreset: 'From preset ({tier})', adaptive: 'Adaptive resolution', showFps: 'Show frame rate',
    postFailed: 'Post-processing is unavailable on this device; the table renders without it.',
    unknownGpu: 'unknown GPU',
    presets: { low: 'Low', balanced: 'Balanced', high: 'High', ultra: 'Ultra' },
    cats: { shadows: 'Shadows', ao: 'Ambient occlusion', bloom: 'Bloom', grade: 'Color grade',
      antialias: 'Anti-aliasing', reflections: 'Reflections', detail: 'Table detail', particles: 'Particles' },
    tiers: { off: 'Off', low: 'Low', medium: 'Medium', high: 'High', on: 'On', fxaa: 'FXAA', smaa: 'SMAA',
      msaa: 'MSAA', plain: 'Plain', detailed: 'Detailed' },
    sum: { noShadows: 'no shadows', shadows: '{n}² shadows', ao: 'ambient occlusion', aoHigh: 'full ambient occlusion',
      bloom: 'bloom', reflections: 'reflections', noAA: 'no anti-aliasing' },
  };

  function merge(base, over) {
    const out = {};
    for (const k in base) out[k] = (typeof base[k] === 'object') ? Object.assign({}, base[k], over[k] || {}) : (over[k] !== undefined ? over[k] : base[k]);
    return out;
  }

  const STRINGS = { 'en-US': EN };
  STRINGS['en-GB'] = merge(EN, { cats: { grade: 'Colour grade' } });
  STRINGS['de-DE'] = merge(EN, {
    title: 'Grafik', quality: 'Qualität', auto: 'Automatisch (erkannt: {tier})', scale: 'Renderskalierung',
    fromPreset: 'Wie Voreinstellung ({tier})', adaptive: 'Adaptive Auflösung', showFps: 'Bildrate anzeigen',
    postFailed: 'Nachbearbeitung ist auf diesem Gerät nicht verfügbar; der Tisch wird ohne sie dargestellt.',
    unknownGpu: 'unbekannte GPU',
    presets: { low: 'Niedrig', balanced: 'Ausgewogen', high: 'Hoch', ultra: 'Ultra' },
    cats: { shadows: 'Schatten', ao: 'Umgebungsverdeckung', bloom: 'Leuchteffekt', grade: 'Farbkorrektur',
      antialias: 'Kantenglättung', reflections: 'Spiegelungen', detail: 'Tischdetails', particles: 'Partikel' },
    tiers: { off: 'Aus', low: 'Niedrig', medium: 'Mittel', high: 'Hoch', on: 'An', plain: 'Schlicht', detailed: 'Detailliert' },
    sum: { noShadows: 'keine Schatten', shadows: '{n}²-Schatten', ao: 'Umgebungsverdeckung', aoHigh: 'volle Umgebungsverdeckung',
      bloom: 'Leuchteffekt', reflections: 'Spiegelungen', noAA: 'keine Kantenglättung' },
  });
  STRINGS['fr-FR'] = merge(EN, {
    title: 'Graphismes', quality: 'Qualité', auto: 'Auto (détectée : {tier})', scale: 'Échelle de rendu',
    fromPreset: 'Selon le préréglage ({tier})', adaptive: 'Résolution adaptative', showFps: 'Afficher la fréquence d’images',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil ; la table est affichée sans.',
    unknownGpu: 'GPU inconnu',
    presets: { low: 'Faible', balanced: 'Équilibrée', high: 'Élevée', ultra: 'Ultra' },
    cats: { shadows: 'Ombres', ao: 'Occlusion ambiante', bloom: 'Halo lumineux', grade: 'Étalonnage des couleurs',
      antialias: 'Anticrénelage', reflections: 'Reflets', detail: 'Détails de la table', particles: 'Particules' },
    tiers: { off: 'Désactivé', low: 'Faible', medium: 'Moyen', high: 'Élevé', on: 'Activé', plain: 'Simple', detailed: 'Détaillé' },
    sum: { noShadows: 'sans ombres', shadows: 'ombres {n}²', ao: 'occlusion ambiante', aoHigh: 'occlusion ambiante complète',
      bloom: 'halo', reflections: 'reflets', noAA: 'sans anticrénelage' },
  });
  STRINGS['fr-CA'] = merge(STRINGS['fr-FR'], {
    title: 'Graphiques', showFps: 'Afficher le nombre d’images par seconde',
    postFailed: 'Le post-traitement n’est pas disponible sur cet appareil; la table est affichée sans.',
  });
  STRINGS['es-ES'] = merge(EN, {
    title: 'Gráficos', quality: 'Calidad', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderizado',
    fromPreset: 'Según el preajuste ({tier})', adaptive: 'Resolución adaptativa', showFps: 'Mostrar fotogramas por segundo',
    postFailed: 'El posprocesado no está disponible en este dispositivo; la mesa se muestra sin él.',
    unknownGpu: 'GPU desconocida',
    presets: { low: 'Baja', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusión ambiental', bloom: 'Resplandor', grade: 'Corrección de color',
      antialias: 'Suavizado de bordes', reflections: 'Reflejos', detail: 'Detalle de la mesa', particles: 'Partículas' },
    tiers: { off: 'Desactivado', low: 'Bajo', medium: 'Medio', high: 'Alto', on: 'Activado', plain: 'Sencillo', detailed: 'Detallado' },
    sum: { noShadows: 'sin sombras', shadows: 'sombras {n}²', ao: 'oclusión ambiental', aoHigh: 'oclusión ambiental completa',
      bloom: 'resplandor', reflections: 'reflejos', noAA: 'sin suavizado' },
  });
  STRINGS['es-419'] = merge(STRINGS['es-ES'], {
    fromPreset: 'Según el ajuste predefinido ({tier})', showFps: 'Mostrar cuadros por segundo',
    postFailed: 'El posprocesamiento no está disponible en este dispositivo; la mesa se muestra sin él.',
  });
  STRINGS['pt-BR'] = merge(EN, {
    title: 'Gráficos', quality: 'Qualidade', auto: 'Automática (detectada: {tier})', scale: 'Escala de renderização',
    fromPreset: 'Conforme a predefinição ({tier})', adaptive: 'Resolução adaptável', showFps: 'Mostrar taxa de quadros',
    postFailed: 'O pós-processamento não está disponível neste dispositivo; a mesa é exibida sem ele.',
    unknownGpu: 'GPU desconhecida',
    presets: { low: 'Baixa', balanced: 'Equilibrada', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Sombras', ao: 'Oclusão de ambiente', bloom: 'Brilho', grade: 'Correção de cor',
      antialias: 'Antisserrilhamento', reflections: 'Reflexos', detail: 'Detalhes da mesa', particles: 'Partículas' },
    tiers: { off: 'Desligado', low: 'Baixo', medium: 'Médio', high: 'Alto', on: 'Ligado', plain: 'Simples', detailed: 'Detalhado' },
    sum: { noShadows: 'sem sombras', shadows: 'sombras {n}²', ao: 'oclusão de ambiente', aoHigh: 'oclusão de ambiente completa',
      bloom: 'brilho', reflections: 'reflexos', noAA: 'sem antisserrilhamento' },
  });
  STRINGS['it-IT'] = merge(EN, {
    title: 'Grafica', quality: 'Qualità', auto: 'Automatica (rilevata: {tier})', scale: 'Scala di rendering',
    fromPreset: 'Come da preimpostazione ({tier})', adaptive: 'Risoluzione adattiva', showFps: 'Mostra frequenza fotogrammi',
    postFailed: 'La post-elaborazione non è disponibile su questo dispositivo; il tavolo viene mostrato senza.',
    unknownGpu: 'GPU sconosciuta',
    presets: { low: 'Bassa', balanced: 'Bilanciata', high: 'Alta', ultra: 'Ultra' },
    cats: { shadows: 'Ombre', ao: 'Occlusione ambientale', bloom: 'Bagliore', grade: 'Correzione colore',
      antialias: 'Antialiasing', reflections: 'Riflessi', detail: 'Dettagli del tavolo', particles: 'Particelle' },
    tiers: { off: 'Disattivato', low: 'Basso', medium: 'Medio', high: 'Alto', on: 'Attivato', plain: 'Semplice', detailed: 'Dettagliato' },
    sum: { noShadows: 'senza ombre', shadows: 'ombre {n}²', ao: 'occlusione ambientale', aoHigh: 'occlusione ambientale completa',
      bloom: 'bagliore', reflections: 'riflessi', noAA: 'senza antialiasing' },
  });

  const LOCALES = Object.keys(STRINGS);

  /** Best supported locale for a BCP-47 tag (exact, then regional fallback by language). */
  function pickLocale(tag) {
    const t = String(tag || 'en-US');
    for (const l of LOCALES) if (l.toLowerCase() === t.toLowerCase()) return l;
    const lang = t.slice(0, 2).toLowerCase();
    return { en: 'en-US', de: 'de-DE', fr: 'fr-FR', es: 'es-419', pt: 'pt-BR', it: 'it-IT' }[lang] || 'en-US';
  }

  function fmt(s, vars) { return s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k]; }); }

  /** Localized cost summary: "GPU · shadows · … · W×H px". */
  function summary(L, info) {
    const r = info.resolved;
    const parts = [
      info.gpu || L.unknownGpu,
      r.shadows === 'off' ? L.sum.noShadows : fmt(L.sum.shadows, { n: Gfx.SHADOW_MAP[r.shadows] }),
      r.ao === 'off' ? null : r.ao === 'high' ? L.sum.aoHigh : L.sum.ao,
      r.bloom === 'on' ? L.sum.bloom : null,
      r.reflections === 'on' ? L.sum.reflections : null,
      r.antialias === 'off' ? L.sum.noAA : r.antialias.toUpperCase(),
      info.pixels ? info.pixels[0] + '×' + info.pixels[1] + ' px' : null,
    ];
    return parts.filter(Boolean).join(' · ');
  }

  /**
   * Build and bind the panel.
   * opts: { settings, save(), onChange(), info() -> { gpu, detected, resolved, pixels, postFailed }, locale }
   */
  function mount(opts) {
    const host = document.getElementById('gfx-section');
    if (!host) return null;
    const L = STRINGS[pickLocale(opts.locale)];
    const s = opts.settings;
    if (!s.graphics || typeof s.graphics !== 'object') s.graphics = { preset: 'auto' };
    const qSel = document.getElementById('set-quality');
    const self = { L: L };

    function el(tag, attrs, text) {
      const e = document.createElement(tag);
      for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
      if (text !== undefined) e.textContent = text;
      return e;
    }
    host.querySelector('h3').textContent = L.title;
    host.setAttribute('lang', pickLocale(opts.locale));
    document.querySelector('label[for="set-quality"]').textContent = L.quality;

    // render scale
    const grid = host.querySelector('.gfx-grid');
    const scaleField = el('div', { class: 'field gfx-scale' });
    const scaleLab = el('label', { for: 'gfx-scale' });
    const scaleName = el('span', {}, L.scale);
    const scaleVal = el('output', { id: 'gfx-scale-value', for: 'gfx-scale' });
    scaleLab.append(scaleName, ' ', scaleVal);
    const scale = el('input', { id: 'gfx-scale', type: 'range', min: '50', max: '200', step: '10', 'data-gfx': 'render_scale' });
    scaleField.append(scaleLab, scale);
    grid.appendChild(scaleField);

    // one select per category
    const catSel = {};
    for (const cat in Gfx.CATEGORIES) {
      const f = el('div', { class: 'field' });
      f.appendChild(el('label', { for: 'gfx-cat-' + cat }, L.cats[cat]));
      const sel = el('select', { id: 'gfx-cat-' + cat, 'data-gfx-cat': cat });
      sel.appendChild(el('option', { value: 'preset' }));
      for (const t of Gfx.CATEGORIES[cat]) sel.appendChild(el('option', { value: t }, L.tiers[t]));
      f.appendChild(sel);
      grid.appendChild(f);
      catSel[cat] = sel;
    }

    const toggles = host.querySelector('.gfx-toggles');
    function toggle(id, key, text) {
      const lab = el('label', { class: 'gfx-toggle' });
      const cb = el('input', { id: id, type: 'checkbox', 'data-gfx': key });
      lab.append(cb, ' ' + text);
      toggles.appendChild(lab);
      return cb;
    }
    const adaptive = toggle('gfx-adaptive', 'adaptive', L.adaptive);
    const showFps = toggle('gfx-show-fps', 'show_fps', L.showFps);
    const sumEl = document.getElementById('gfx-summary');
    const noteEl = document.getElementById('gfx-post-note');
    noteEl.textContent = L.postFailed;

    function commit() {
      opts.save();
      opts.onChange();
      refresh();
    }

    function refresh() {
      const g = s.graphics;
      const info = opts.info();
      const r = info.resolved;
      // quality options: Auto shows the detected tier
      qSel.innerHTML = '';
      qSel.appendChild(el('option', { value: 'auto' }, fmt(L.auto, { tier: L.presets[info.detected] })));
      for (const p of Gfx.PRESETS) qSel.appendChild(el('option', { value: p }, L.presets[p]));
      qSel.value = Gfx.PRESETS.indexOf(g.preset) >= 0 ? g.preset : 'auto';
      const pct = Math.round((Number(g.render_scale) || 1) * 100);
      scale.value = String(pct);
      scaleVal.textContent = pct + '%';
      for (const cat in catSel) {
        catSel[cat].options[0].textContent = fmt(L.fromPreset, { tier: L.tiers[Gfx.presetTier(r.preset, cat)] });
        catSel[cat].value = Gfx.CATEGORIES[cat].indexOf(g[cat]) >= 0 ? g[cat] : 'preset';
      }
      adaptive.checked = g.adaptive !== false;
      showFps.checked = !!g.show_fps;
      sumEl.textContent = summary(L, info);
      noteEl.hidden = !info.postFailed;
    }
    self.refresh = refresh;
    self.refreshSummary = function () {
      const info = opts.info();
      sumEl.textContent = summary(L, info);
      noteEl.hidden = !info.postFailed;
    };

    qSel.addEventListener('change', function () {
      s.graphics = Gfx.choosePreset(s.graphics, qSel.value); // a preset clears overrides
      commit();
    });
    scale.addEventListener('input', function () { scaleVal.textContent = scale.value + '%'; });
    scale.addEventListener('change', function () {
      s.graphics.render_scale = Math.min(2, Math.max(0.5, parseInt(scale.value, 10) / 100));
      commit();
    });
    for (const cat in catSel) {
      catSel[cat].addEventListener('change', function () {
        if (catSel[cat].value === 'preset') delete s.graphics[cat];
        else s.graphics[cat] = catSel[cat].value;
        commit();
      });
    }
    adaptive.addEventListener('change', function () { s.graphics.adaptive = adaptive.checked; commit(); });
    showFps.addEventListener('change', function () { s.graphics.show_fps = showFps.checked; commit(); });
    refresh();
    return self;
  }

  return { STRINGS: STRINGS, LOCALES: LOCALES, pickLocale: pickLocale, summary: summary, mount: mount };
});
