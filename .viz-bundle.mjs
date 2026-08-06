// <stdin>
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// src/features/grid/components/network-charts.tsx
import { useState } from "react";

// src/features/grid/lib/months.ts
function fmtMonthShort(lab) {
  const [y, m] = lab.split("-");
  return `${m ?? lab}/${(y ?? "").slice(2)}`;
}

// src/features/grid/components/network-charts.tsx
import { jsx, jsxs } from "react/jsx-runtime";
var SERIE_COULEURS = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)"];
function NetworkLineChart({
  labels: labels2,
  values: values2,
  stores: stores2,
  perStore: perStore2
}) {
  const [survol, setSurvol] = useState(null);
  const n = values2.length;
  const memeTaille = (s) => Array.isArray(s) && s.length === n && n > 0;
  const avecParMag = memeTaille(perStore2);
  const avecMagasins = memeTaille(stores2);
  const fmt = (v, d = 0) => v.toLocaleString("fr-FR", { minimumFractionDigits: d, maximumFractionDigits: d });
  const facettes = [];
  if (avecParMag) {
    facettes.push({
      titre: "Qt\xE9 / magasin",
      valeurs: perStore2,
      couleur: SERIE_COULEURS[0],
      hauteur: 92,
      aire: true,
      decimales: perStore2.some((v) => v > 0 && v < 10) ? 1 : 0
    });
    facettes.push({ titre: "Quantit\xE9s vendues", valeurs: values2, couleur: SERIE_COULEURS[1], hauteur: 58 });
  } else {
    facettes.push({ titre: "Quantit\xE9s vendues", valeurs: values2, couleur: SERIE_COULEURS[0], hauteur: 110, aire: true });
  }
  if (avecMagasins) {
    facettes.push({ titre: "Magasins vendeurs", valeurs: stores2, couleur: SERIE_COULEURS[2], hauteur: 46 });
  }
  const W = 520;
  const padL = 16, padR = 16, axeH = 18, enteteH = 15, ecart = 12;
  const plotW = W - padL - padR;
  const H = facettes.reduce((t, f) => t + enteteH + f.hauteur + ecart, 0) - ecart + axeH;
  const x = (i) => n > 1 ? padL + i / (n - 1) * plotW : padL + plotW / 2;
  const ancrage = (i) => i === 0 ? "start" : i === n - 1 ? "end" : "middle";
  let curseur = 0;
  const disposees = facettes.map((f) => {
    const hautEntete = curseur;
    const haut = curseur + enteteH;
    curseur = haut + f.hauteur + ecart;
    const min = Math.min(0, ...f.valeurs);
    const max = Math.max(...f.valeurs, min + 1);
    const etendue = max - min || 1;
    const y = (v) => haut + f.hauteur - (v - min) / etendue * f.hauteur;
    const iMax = f.valeurs.indexOf(Math.max(...f.valeurs));
    return { ...f, hautEntete, haut, base: y(min), max, y, iMax };
  });
  const basPlots = curseur - ecart;
  return /* @__PURE__ */ jsxs("div", { className: "mt-3 w-full overflow-x-auto", children: [
    /* @__PURE__ */ jsxs(
      "svg",
      {
        viewBox: `0 0 ${W} ${H}`,
        className: "w-full",
        style: { minWidth: 420 },
        role: "img",
        "aria-label": "Ventes r\xE9seau mensuelles : " + disposees.map((f) => f.titre).join(", "),
        onMouseLeave: () => setSurvol(null),
        children: [
          disposees.map((f) => {
            const pts = f.valeurs.map((v, i) => `${x(i).toFixed(1)},${f.y(v).toFixed(1)}`).join(" ");
            const aEtiqueter = [.../* @__PURE__ */ new Set([f.iMax, n - 1])];
            return /* @__PURE__ */ jsxs("g", { children: [
              /* @__PURE__ */ jsx("rect", { x: padL, y: f.hautEntete + 3, width: 12, height: 3, rx: 1.5, fill: f.couleur }),
              /* @__PURE__ */ jsx("text", { x: padL + 18, y: f.hautEntete + 7, fontSize: 9.5, fontWeight: 600, fill: "var(--text-secondary)", dominantBaseline: "middle", children: f.titre }),
              /* @__PURE__ */ jsxs("text", { x: padL + plotW, y: f.hautEntete + 7, textAnchor: "end", fontSize: 9, fill: "var(--text-muted)", dominantBaseline: "middle", children: [
                "max ",
                fmt(f.max, f.decimales ?? 0),
                f.unite ?? ""
              ] }),
              /* @__PURE__ */ jsx("line", { x1: padL, y1: f.base, x2: padL + plotW, y2: f.base, stroke: "var(--border)", strokeWidth: 1 }),
              f.aire && n > 1 && /* @__PURE__ */ jsx(
                "polygon",
                {
                  points: `${padL},${f.base.toFixed(1)} ${pts} ${(padL + plotW).toFixed(1)},${f.base.toFixed(1)}`,
                  fill: f.couleur,
                  opacity: 0.1
                }
              ),
              n > 1 && /* @__PURE__ */ jsx("polyline", { points: pts, fill: "none", stroke: f.couleur, strokeWidth: 2, strokeLinejoin: "round", strokeLinecap: "round" }),
              aEtiqueter.map((i) => /* @__PURE__ */ jsx(
                "circle",
                {
                  cx: x(i),
                  cy: f.y(f.valeurs[i]),
                  r: 4,
                  fill: f.couleur,
                  stroke: "var(--bg-surface)",
                  strokeWidth: 2
                },
                `pt-${f.titre}-${i}`
              )),
              aEtiqueter.map((i) => {
                const yPoint = f.y(f.valeurs[i]);
                const dessus = yPoint - 8 >= f.haut + 8;
                return /* @__PURE__ */ jsx(
                  "text",
                  {
                    x: x(i),
                    y: dessus ? yPoint - 8 : yPoint + 13,
                    textAnchor: ancrage(i),
                    fontSize: 9,
                    fontWeight: 700,
                    fill: "var(--text-primary)",
                    children: fmt(f.valeurs[i], f.decimales ?? 0)
                  },
                  `lab-${f.titre}-${i}`
                );
              }),
              survol != null && /* @__PURE__ */ jsx(
                "circle",
                {
                  cx: x(survol),
                  cy: f.y(f.valeurs[survol]),
                  r: 3.5,
                  fill: f.couleur,
                  stroke: "var(--bg-surface)",
                  strokeWidth: 2
                }
              )
            ] }, f.titre);
          }),
          survol != null && /* @__PURE__ */ jsx("line", { x1: x(survol), y1: 0, x2: x(survol), y2: basPlots, stroke: "var(--border-strong)", strokeWidth: 1 }),
          labels2.map((lab, i) => /* @__PURE__ */ jsx(
            "text",
            {
              x: x(i),
              y: H - 5,
              textAnchor: ancrage(i),
              fontSize: 8.5,
              fill: survol === i ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: survol === i ? 700 : 400,
              children: fmtMonthShort(lab)
            },
            `mois-${lab}`
          )),
          survol != null && (() => {
            const largeur = 158;
            const hauteur = 16 + disposees.length * 13 + 8;
            const gauche = x(survol) + 10 + largeur > W - 4;
            const bx = gauche ? x(survol) - 10 - largeur : x(survol) + 10;
            return /* @__PURE__ */ jsxs("g", { pointerEvents: "none", children: [
              /* @__PURE__ */ jsx(
                "rect",
                {
                  x: bx,
                  y: 4,
                  width: largeur,
                  height: hauteur,
                  rx: 8,
                  fill: "var(--bg-elevated)",
                  stroke: "var(--border)",
                  strokeWidth: 1
                }
              ),
              /* @__PURE__ */ jsx("text", { x: bx + 9, y: 17, fontSize: 9.5, fontWeight: 700, fill: "var(--text-primary)", children: fmtMonthShort(labels2[survol]) }),
              disposees.map((f, k) => /* @__PURE__ */ jsxs("g", { children: [
                /* @__PURE__ */ jsx("rect", { x: bx + 9, y: 26 + k * 13, width: 8, height: 3, rx: 1.5, fill: f.couleur }),
                /* @__PURE__ */ jsx("text", { x: bx + 22, y: 30 + k * 13, fontSize: 9, fill: "var(--text-secondary)", children: f.titre }),
                /* @__PURE__ */ jsx(
                  "text",
                  {
                    x: bx + largeur - 9,
                    y: 30 + k * 13,
                    textAnchor: "end",
                    fontSize: 9,
                    fontWeight: 700,
                    fill: "var(--text-primary)",
                    children: fmt(f.valeurs[survol], f.decimales ?? 0)
                  }
                )
              ] }, `bulle-${f.titre}`))
            ] });
          })(),
          labels2.map((lab, i) => /* @__PURE__ */ jsx(
            "rect",
            {
              x: x(i) - plotW / (2 * Math.max(1, n - 1)),
              y: 0,
              width: plotW / Math.max(1, n - 1),
              height: H,
              fill: "transparent",
              onMouseEnter: () => setSurvol(i)
            },
            `survol-${lab}`
          ))
        ]
      }
    ),
    /* @__PURE__ */ jsxs("details", { className: "mt-2", children: [
      /* @__PURE__ */ jsx("summary", { className: "text-[11px] cursor-pointer select-none", style: { color: "var(--text-muted)" }, children: "Voir les valeurs mois par mois" }),
      /* @__PURE__ */ jsx("div", { className: "mt-1.5 overflow-x-auto", children: /* @__PURE__ */ jsxs("table", { className: "w-full text-[11px] tabular-nums", style: { borderCollapse: "collapse" }, children: [
        /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { style: { color: "var(--text-muted)" }, children: [
          /* @__PURE__ */ jsx("th", { className: "text-left font-medium py-1 pr-2", children: "Mois" }),
          disposees.map((f) => /* @__PURE__ */ jsx("th", { className: "text-right font-medium py-1 pl-2", children: f.titre }, `th-${f.titre}`))
        ] }) }),
        /* @__PURE__ */ jsx("tbody", { children: labels2.map((lab, i) => /* @__PURE__ */ jsxs("tr", { style: { borderTop: "1px solid var(--border)" }, children: [
          /* @__PURE__ */ jsx("td", { className: "py-1 pr-2", style: { color: "var(--text-secondary)" }, children: fmtMonthShort(lab) }),
          disposees.map((f) => /* @__PURE__ */ jsx("td", { className: "text-right py-1 pl-2", style: { color: "var(--text-primary)" }, children: fmt(f.valeurs[i], f.decimales ?? 0) }, `td-${f.titre}-${lab}`))
        ] }, `tr-${lab}`)) })
      ] }) })
    ] })
  ] });
}

// <stdin>
var labels = ["2025-08", "2025-09", "2025-10", "2025-11", "2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07"];
var values = [9953, 13258, 6353, 5429, 3741, 6522, 8211, 4437, 4035, 4066, 2936, 4470];
var stores = [208, 228, 196, 177, 175, 193, 206, 190, 179, 179, 167, 170];
var perStore = values.map((v, i) => stores[i] > 0 ? v / stores[i] : 0);
globalThis.__HTML__ = renderToStaticMarkup(
  React.createElement(NetworkLineChart, { labels, values, stores, perStore })
);
