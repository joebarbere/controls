/*
 * GENERATED from content/tables/*.json by content-mirrors.spec.ts: do not edit. Edit the JSON
 * files and regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_TABLE_DOCUMENTS: readonly unknown[] = [
{
  "table": "colours",
  "version": 1,
  "title": "Conductor, stripe and jacket colours",
  "rows": {
    "bare": {
      "name": "Bare copper",
      "srgb": "#b87333"
    },
    "black": {
      "name": "Black",
      "srgb": "#1c1c1c"
    },
    "blue": {
      "name": "Blue",
      "srgb": "#1f4fbf"
    },
    "brown": {
      "name": "Brown",
      "srgb": "#6b4528"
    },
    "green": {
      "name": "Green",
      "srgb": "#2e7d32"
    },
    "grey": {
      "name": "Grey (gray)",
      "srgb": "#8a8a8a"
    },
    "orange": {
      "name": "Orange",
      "srgb": "#ef7d00"
    },
    "pink": {
      "name": "Pink",
      "srgb": "#e87ea1"
    },
    "purple": {
      "name": "Purple",
      "srgb": "#6a3d9a"
    },
    "red": {
      "name": "Red",
      "srgb": "#c62828"
    },
    "white": {
      "name": "White",
      "srgb": "#ededed"
    },
    "yellow": {
      "name": "Yellow",
      "srgb": "#f2c200"
    }
  },
  "sources": [
    {
      "id": "display-colours",
      "kind": "game-design",
      "citation": "game-design: display values only, chosen to read well under the game's lighting and against each other. They are not colour standards and never take part in a check: what a conductor is made in, and what the region's rules say about it, are colour ids. The ids are append-only across versions (ADR 0015). The set covers the colours building wire and cable jackets are commonly sold in, and bare copper.",
      "covers": [
        "rows.*.srgb"
      ]
    }
  ],
  "extensions": {}
},
{
  "table": "insulation",
  "version": 1,
  "title": "Conductor insulation and cable jackets",
  "rows": {
    "mtw": {
      "name": "MTW",
      "material": "PVC insulation, single layer (machine tool wire)",
      "ratedTempDryK": 363.15,
      "ratedTempWetK": 333.15,
      "thermalConductivityWPerMK": 0.18,
      "jacketThermalConductivityWPerMK": null,
      "emissivity": 0.9
    },
    "nmbJacket": {
      "name": "NM-B cable jacket",
      "material": "PVC outer jacket of a non-metallic-sheathed cable",
      "ratedTempDryK": 363.15,
      "ratedTempWetK": null,
      "thermalConductivityWPerMK": 0.18,
      "jacketThermalConductivityWPerMK": null,
      "emissivity": 0.9
    },
    "thhnThwn2": {
      "name": "THHN/THWN-2",
      "material": "PVC insulation with an extruded nylon jacket",
      "ratedTempDryK": 363.15,
      "ratedTempWetK": 363.15,
      "thermalConductivityWPerMK": 0.18,
      "jacketThermalConductivityWPerMK": 0.25,
      "emissivity": 0.9
    },
    "xhhw2": {
      "name": "XHHW-2",
      "material": "Cross-linked polyethylene (XLPE), single layer",
      "ratedTempDryK": 363.15,
      "ratedTempWetK": 363.15,
      "thermalConductivityWPerMK": 0.29,
      "jacketThermalConductivityWPerMK": null,
      "emissivity": 0.9
    }
  },
  "sources": [
    {
      "id": "ul-type-ratings",
      "kind": "real-world",
      "citation": "Conductor temperature ratings of the types as public manufacturers' specification sheets state them for wire listed to the UL standards, cited by number only (UL 83 for THHN/THWN-2, UL 44 for XHHW-2, UL 1063 for MTW, UL 719 for NM-B), paraphrased: THHN 90 °C in dry locations; THWN-2 and XHHW-2 90 °C in wet or dry locations; MTW 90 °C dry and 60 °C wet; NM-B 90 °C, which is the rating of the cable's conductors, not of the jacket compound (the jacket row carries the cable's rating). Not taken from the NEC's conductor-insulation table. How much current a rating allows is derived by the thermal model (D6), never stored.",
      "covers": [
        "rows.thhnThwn2.ratedTempDryK",
        "rows.thhnThwn2.ratedTempWetK",
        "rows.xhhw2.ratedTempDryK",
        "rows.xhhw2.ratedTempWetK",
        "rows.mtw.ratedTempDryK",
        "rows.mtw.ratedTempWetK",
        "rows.nmbJacket.ratedTempDryK"
      ]
    },
    {
      "id": "nm-dry-locations",
      "kind": "real-world",
      "citation": "NFPA 70-2023 Art. 334.12 (uses not permitted; cited by number and paraphrased) keeps NM cable out of wet and damp locations, so the NM-B jacket row has no wet rating.",
      "covers": [
        "rows.nmbJacket.ratedTempWetK"
      ]
    },
    {
      "id": "pvc-nylon-conductivity",
      "kind": "real-world",
      "citation": "Thermal conductivity of PVC about 0.16 to 0.20 W/(m·K) (0.18 is taken, mid-band) and of nylon 6/6 about 0.25 W/(m·K), from a plastics distributor's published thermal-property table (read by electrical-realism-reviewer in the P3 source pre-audit), paraphrased. Compound-to-compound spread is about as large as the difference between the two.",
      "covers": [
        "rows.thhnThwn2.thermalConductivityWPerMK",
        "rows.thhnThwn2.jacketThermalConductivityWPerMK",
        "rows.mtw.thermalConductivityWPerMK",
        "rows.nmbJacket.thermalConductivityWPerMK"
      ]
    },
    {
      "id": "single-layer-constructions",
      "kind": "game-design",
      "citation": "game-design choice inside real constructions: XHHW-2 is a single XLPE layer and an NM-B jacket a single PVC layer; MTW is made both as plain PVC and with a nylon jacket, and the single-layer variant is taken here. So these rows have no outer jacket layer.",
      "covers": [
        "rows.mtw.jacketThermalConductivityWPerMK",
        "rows.xhhw2.jacketThermalConductivityWPerMK",
        "rows.nmbJacket.jacketThermalConductivityWPerMK"
      ]
    },
    {
      "id": "xlpe-conductivity-unverified",
      "kind": "game-design",
      "citation": "game-design: unverified, so not a measurement. XLPE thermal conductivity of about 0.29 W/(m·K) appears only in a secondary source (a field-simulation package's material library); the primary reference, IEC 60287-2-1, is paywalled and was not read. Replace with a verified figure, as a new table version, when one is found.",
      "covers": [
        "rows.xhhw2.thermalConductivityWPerMK"
      ]
    },
    {
      "id": "surface-emissivity",
      "kind": "game-design",
      "citation": "game-design judgement: a total emissivity of 0.9 for every insulation and jacket surface. An infrared-thermometer maker's emissivity table gives about 0.93 for PVC (read in the P3 source pre-audit); colours and nylon differ a little. Radiation is kept because it carries 20 to 30 % of a small conductor's heat in free air (D6).",
      "covers": [
        "rows.*.emissivity"
      ]
    }
  ],
  "extensions": {}
},
{
  "table": "materials",
  "version": 1,
  "title": "Conductor metals",
  "rows": {
    "aluminiumAa8000": {
      "name": "Aluminium conductor alloy, AA-8000 series (61.0 % IACS)",
      "conductivityIacsPercent": 61,
      "resistivityOhmM": 2.8264e-8,
      "referenceTemperatureK": 293.15,
      "temperatureCoefficientPerK": 0.00403,
      "linearAlphaMaxK": 473.15,
      "densityKgM3": 2703,
      "specificHeatJPerKgK": 897,
      "meltingPointK": 933.473
    },
    "copperAnnealed": {
      "name": "Annealed copper (100 % IACS)",
      "conductivityIacsPercent": 100,
      "resistivityOhmM": 1.724137931034483e-8,
      "referenceTemperatureK": 293.15,
      "temperatureCoefficientPerK": 0.00393,
      "linearAlphaMaxK": 473.15,
      "densityKgM3": 8890,
      "specificHeatJPerKgK": 385,
      "meltingPointK": 1357.77
    }
  },
  "sources": [
    {
      "id": "nbs-hb100-copper",
      "kind": "real-world",
      "citation": "NBS Handbook 100, Copper Wire Tables (1966; https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nbshandbook100.pdf, read in full by electrical-realism-reviewer), on the International Annealed Copper Standard (adopted by the IEC in 1913; 1925 is a revised edition): annealed copper at 20 °C (293.15 K) has a resistivity of 1/58 Ω·mm²/m (1.72414 × 10⁻⁸ Ω·m, defining 100 % IACS), a temperature coefficient of resistance of 0.00393 per kelvin and a density of 8.89 g/cm³; resistance is treated as linear in temperature up to 200 °C (473.15 K), where the engine clamps R(T). Paraphrased; no table reproduced.",
      "covers": [
        "rows.copperAnnealed.conductivityIacsPercent",
        "rows.copperAnnealed.resistivityOhmM",
        "rows.copperAnnealed.referenceTemperatureK",
        "rows.copperAnnealed.temperatureCoefficientPerK",
        "rows.copperAnnealed.linearAlphaMaxK",
        "rows.copperAnnealed.densityKgM3"
      ]
    },
    {
      "id": "nbs-hb109-aluminium",
      "kind": "real-world",
      "citation": "NBS Handbook 109, Aluminum Wire Tables (1972; https://nvlpubs.nist.gov/nistpubs/Legacy/hb/nbshandbook109.pdf, read in full by electrical-realism-reviewer), its first table at 61.0 % IACS: a resistivity of 0.028264 Ω·mm²/m (2.8264 × 10⁻⁸ Ω·m) at 20 °C, a temperature coefficient of resistance of 0.00403 per kelvin at 20 °C and a density of 2.703 g/cm³. Aluminium building wire is an AA-8000-series alloy (ASTM B800, paywalled, not read); 61.0 % IACS is taken as the grade's assumed minimum conductivity, so this row is the 8000-series conductor at that conductivity. Al/Cu resistance ratio 1/0.610 = 1.6393. Paraphrased; no table reproduced.",
      "covers": [
        "rows.aluminiumAa8000.conductivityIacsPercent",
        "rows.aluminiumAa8000.resistivityOhmM",
        "rows.aluminiumAa8000.referenceTemperatureK",
        "rows.aluminiumAa8000.temperatureCoefficientPerK",
        "rows.aluminiumAa8000.densityKgM3"
      ]
    },
    {
      "id": "aluminium-linear-range",
      "kind": "game-design",
      "citation": "game-design: the linear temperature-coefficient model is taken to hold for the aluminium alloy up to the same 200 °C (473.15 K) as copper. Handbook 109 gives α at 20 °C; its validity range for the 8000-series alloy was not verified.",
      "covers": [
        "rows.aluminiumAa8000.linearAlphaMaxK"
      ]
    },
    {
      "id": "nist-janaf-heat-capacity",
      "kind": "real-world",
      "citation": "Specific heat near 25 °C derived from the NIST-JANAF Thermochemical Tables (M. W. Chase Jr., 4th ed., J. Phys. Chem. Ref. Data Monograph 9, 1998) through the solid-phase Shomate fits published in the NIST Chemistry WebBook (read): copper 24.47 J/(mol·K) ÷ 63.546 g/mol = 385 J/(kg·K); aluminium 24.21 J/(mol·K) ÷ 26.982 g/mol = 897 J/(kg·K), the pure metal standing in for the dilute 8000-series alloy. Taken as constant over the conductor's temperature range (it rises slowly with temperature), an abstraction the thermal model states.",
      "covers": [
        "rows.*.specificHeatJPerKgK"
      ]
    },
    {
      "id": "its-90-fixed-points",
      "kind": "real-world",
      "citation": "The International Temperature Scale of 1990 (H. Preston-Thomas, Metrologia 27, 3-10, 1990), whose defining fixed points include the freezing points of aluminium (933.473 K) and copper (1357.77 K). A public reference, not re-read for this table: electrical-realism-reviewer to confirm (ADR 0018 §5). Pure aluminium stands in for the 8000-series alloy, whose solidus is slightly lower. The engine burns a conductor or termination open when its node reaches the melting point, and never reports a node above it (F3.6 part 2).",
      "covers": [
        "rows.*.meltingPointK"
      ]
    }
  ],
  "extensions": {}
}
];
