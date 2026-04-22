# Catálogo de Treatments Editoriales

Referenciado desde `SPRINT-2026-04-22-autonomy-editorial-voice.md` (Épica C).

Un **treatment** es la firma visual completa de un spread: paleta, fuentes, reglas de layout y kit de animaciones GSAP. No es solo CSS. Cada treatment tiene personalidad propia y cubre una intención narrativa distinta.

## Principios invariantes

1. **No small fonts anywhere**: mínimo 32px en 1080p, 24px en 9:16. El linter lo verifica.
2. **Body siempre legible**: el display puede ser dramático (MedievalSharp, Press Start 2P...), pero el body del cuento nunca. Fonts decorativas solo en título, folios, drop caps, kickers.
3. **Todas las fuentes local**, no runtime Google Fonts. Descargadas a `hyperframes/assets/fonts/`.
4. **Determinista**: `hash(bundle.id)` elige entre candidatos. Mismo input → mismo output.
5. **Responsive a aspect ratio**: cada treatment debe renderizar digno en 1:1, 9:16 y 16:9.

---

## 12 treatments organizados por familia

### Familia Editorial (sobria, magazine-style)

#### 1. `hero-display`
**Intención**: opener dominante, título gigante ocupa la mayoría del spread.
**Fonts**: Fraunces 900 (display) + Inter (body) + Inter 700 (kicker).
**Paletas sugeridas**: `parchment-ember`, `cream-rust`, `bone-ink`.
**Layout**: título a 180px (1080p), kicker uppercase pequeño arriba, byline abajo.
**Animación**: reveal de título palabra a palabra con y-offset.
**Ideal para**: aperturas, cuentos emocionantes, intro de serie.

#### 2. `midnight`
**Intención**: fondo oscuro premium, tipografía clara, accent luminoso.
**Fonts**: Playfair Display (display) + Inter (body).
**Paletas**: `midnight-gold`, `deep-ocean`, `coal-ember`.
**Layout**: kicker accent, título masivo blanco, body con opacity 0.85.
**Animación**: fade-in lento tipo cine, accent pulsante en puntos clave.
**Ideal para**: misterio, suspense, cuentos nocturnos.

#### 3. `rose-stamp`
**Intención**: paleta rosa-crema con sello circular rotativo tipo "destacado".
**Fonts**: Fraunces Italic (display) + Inter (body).
**Paletas**: `rose-cream`, `coral-blush`, `peach-sand`.
**Layout**: sello circular con texto rotatorio (ej: "AUDIOCUENTO · HECHO PARA TI ·"), título a la izquierda.
**Animación**: sello rota lentamente (36deg en total del spread).
**Ideal para**: cuentos dedicados con nombre, regalos, ediciones especiales.

#### 4. `academic-dropcap`
**Intención**: libro clásico, drop cap enorme inicial, texto tipo tratado.
**Fonts**: Cormorant Garamond (display+body) + EB Garamond fallback.
**Paletas**: `parchment-ember`, `ivory-sepia`, `cream-forest`.
**Layout**: drop cap a 240px que ocupa 4 líneas, texto justificado, folio clásico "— 01 —".
**Animación**: drop cap aparece primero, luego body se llena de arriba abajo.
**Ideal para**: fantasia literaria, cuentos reposados, mood `calma` cuando tira a contemplativo.

#### 5. `big-stat`
**Intención**: cierre con un número o dato enorme como protagonista visual.
**Fonts**: Fraunces 900 (display) + JetBrains Mono (números).
**Paletas**: `parchment-ember`, `midnight-gold`, `terminal-green`.
**Layout**: número a 400px centrado, etiqueta abajo explicando.
**Animación**: número cuenta hacia arriba con easing, label fade-in al final.
**Ideal para**: cuentos con estructura de lección, cierres con moraleja numérica, stats en pipelines no-AudioKids.

---

### Familia Infantil (cálido, playful, pastel)

#### 6. `storybook-pop`
**Intención**: colores saturados, tipografía redondeada, vibe cómic amable.
**Fonts**: Baloo 2 (display) + Nunito (body).
**Paletas**: `pop-cherry`, `pop-mint`, `pop-sunflower`.
**Layout**: título con outline grueso tipo cómic, body en bocadillos o rectángulos redondeados.
**Animación**: letras del título bounce-in con stagger, fondo con sutil wobble.
**Ideal para**: `comedia`, cuentos muy dinámicos para edades 4-6.

#### 7. `crayon-doodle`
**Intención**: aspecto dibujado a mano, textura papel, trazos irregulares.
**Fonts**: Caveat (display) + Patrick Hand (body).
**Paletas**: `crayon-primary` (rojo+amarillo+azul), `crayon-pastel`, `pencil-notebook`.
**Layout**: underlines dibujadas, tachones, flechas doodle decorativas en esquinas.
**Animación**: trazos "se dibujan" con stroke-dasharray animada.
**Ideal para**: cuentos muy personales, dedicatorias escolares, ediciones one-shot.

#### 8. `bubble-pastel`
**Intención**: burbujas, colores suaves, redondez total, calmante.
**Fonts**: Quicksand (display) + Nunito (body).
**Paletas**: `bubble-lavender`, `bubble-mint`, `bubble-peach`.
**Layout**: círculos de fondo con blur, pill-shape containers, tipografía 500 no bold.
**Animación**: burbujas flotando lentamente (translateY infinite).
**Ideal para**: `calma`, cuentos de dormir, edades 3-5.

---

### Familia Épica / Fantasía

#### 9. `medieval-manuscript`
**Intención**: manuscrito iluminado, capitulares ornamentadas, pergamino.
**Fonts**: UnifrakturMaguntia (display) + MedievalSharp (folios) + Lora (body legible).
**Paletas**: `manuscript-gold`, `parchment-burgundy`, `vellum-ink`.
**Layout**: drop cap iluminado a 300px con borde dorado ornamental, márgenes anchos con decoraciones, capitulares en cada página.
**Animación**: drop cap brilla con shimmer de oro, borders dibujándose.
**Ideal para**: `fantasia` clásica con reyes/dragones/magos, historias de reinos.

#### 10. `epic-cinematic`
**Intención**: widescreen feel, tipografía monumental, letterboxing.
**Fonts**: Cinzel (display, Roman capitals) + Lato (body).
**Paletas**: `cinema-amber`, `bronze-dusk`, `cold-steel`.
**Layout**: barras negras arriba/abajo, título centrado en caps con tracking amplio, body en franja central.
**Animación**: título emerge con slow zoom-in, letterbox se abre.
**Ideal para**: `aventura` épica, cuentos heroicos, mood `emocionante` con tono serio.

#### 11. `mythic-scroll`
**Intención**: papiro extendido, caligrafía elegante, bordes decorativos.
**Fonts**: Tangerine 700 (display caligráfico) + Cormorant (body).
**Paletas**: `papyrus-sepia`, `scroll-rose`, `vellum-teal`.
**Layout**: bordes con patrones geométricos (SVG), título en cursiva grande, texto centrado.
**Animación**: papiro se desenrolla de arriba abajo, patrón de borde fade-in.
**Ideal para**: mitología, cuentos con moraleja antigua, `naturaleza` con tono ancestral.

---

### Familia Tech / Naturaleza (bonus, menos frecuentes)

#### 12. `terminal-crt`
**Intención**: consola retro, monospace, scan lines, cursor parpadeante.
**Fonts**: JetBrains Mono (todo) + Space Mono (folios).
**Paletas**: `terminal-green` (fondo casi negro + verde fósforo), `terminal-amber`, `terminal-cyan`.
**Layout**: prompt `> ` en cada línea, folios tipo `[PAGE 01/12]`, cursor block parpadea.
**Animación**: texto "se teclea" carácter a carácter en intro, cursor blink infinito, scan lines sutiles.
**Ideal para**: cuentos sci-fi, robots, ordenadores, aventuras digitales para niños.

---

## Mapping `mood` → candidatos de treatment

Cuando el bundle no declara treatment explícito, `resolveTheme()` selecciona entre estos candidatos con `hash(bundle.id) % candidates.length`.

| mood (AudioKids) | candidatos |
|------------------|------------|
| `aventura`       | `epic-cinematic`, `medieval-manuscript`, `hero-display` |
| `calma`          | `bubble-pastel`, `academic-dropcap`, `mythic-scroll` |
| `comedia`        | `storybook-pop`, `crayon-doodle`, `bubble-pastel` |
| `misterio`       | `midnight`, `terminal-crt`, `rose-stamp` |
| `emocionante`    | `hero-display`, `big-stat`, `epic-cinematic` |
| `fantasia`       | `medieval-manuscript`, `mythic-scroll`, `academic-dropcap` |
| `naturaleza`     | `mythic-scroll`, `bubble-pastel`, `academic-dropcap` |

Para pipelines distintos a AudioKids (sin `mood`), el resolver usa keywords del `text.body` o fallback a `hero-display`.

---

## Override explícito

Metadata puede forzar treatment concreto:

```json
{
  "visualTheme": {
    "treatment": "medieval-manuscript",
    "palette": "manuscript-gold",
    "fontPairingId": "unifraktur-lora"
  }
}
```

Prioridad: `treatment explícito` > `palette explícita` > `fonts explícitos` > derivados del treatment.

---

## Entregable auxiliar: galería de previews

Al cerrar Épica C, generar `data/preview-gallery.html`: mismo cuento fixture (dragon-marcos) renderizado con los 12 treatments, uno debajo del otro, para evaluación visual rápida.

Comando CLI: `postiz-agent preview gallery --bundle dragon-marcos --output data/preview-gallery.html`.

---

## Criterios de aceptación globales del catálogo

- [ ] 12 treatments implementados y lintean en `npx hyperframes lint`
- [ ] 36 snapshots de regresión (12 treatments × 3 aspect ratios) en `tests/snapshots/`
- [ ] Body font de cada treatment es legible (>=32px 1080p) incluso si display es decorativa
- [ ] Fuentes descargadas local, cero requests de red en render
- [ ] Galería de previews generable con un comando
- [ ] Mapping mood → candidatos cubre los 7 moods AudioKids
