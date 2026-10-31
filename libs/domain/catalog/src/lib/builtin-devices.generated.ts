/*
 * GENERATED from content/devices/*.json by builtin.spec.ts: do not edit. Edit the JSON files and
 * regenerate with `pnpm nx test catalog -u` (plan P2 decision D4).
 */
export const BUILTIN_DEVICE_DOCUMENTS: readonly unknown[] = [
{
  "id": "battery.ferrovane-12v-7ah",
  "version": 1,
  "title": "12 V 7 Ah sealed lead-acid battery",
  "brand": "Ferrovane",
  "modelName": "FV12-7",
  "category": "source",
  "sizeMm": {
    "widthMm": 151,
    "heightMm": 65,
    "depthMm": 98
  },
  "terminals": [
    {
      "id": "neg",
      "label": "−",
      "positionMm": {
        "x": 18,
        "y": 32,
        "z": 98
      }
    },
    {
      "id": "pos",
      "label": "+",
      "positionMm": {
        "x": 133,
        "y": 32,
        "z": 98
      }
    }
  ],
  "model": {
    "kind": "battery",
    "params": {
      "nominalVoltageV": 12,
      "openCircuitVoltageFullV": 12.9,
      "openCircuitVoltageEmptyV": 11.8,
      "internalResistanceOhm": 0.023,
      "capacityAh": 7
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "vrla-12v-7ah-class",
      "kind": "real-world",
      "citation": "The 12 V 7 Ah valve-regulated lead-acid (VRLA, AGM) monobloc, a common alarm and UPS battery class: six 2 V cells (12 V nominal), 7 Ah at the 20-hour rate, case about 151 × 65 × 94 mm and 98 mm to the terminal tops. Typical of published manufacturer datasheets for the class, paraphrased; not one vendor's values. The size is the footprint on the bench (151 × 65 mm) and the height above it (98 mm).",
      "covers": [
        "model.params.nominalVoltageV",
        "model.params.capacityAh",
        "sizeMm"
      ]
    },
    {
      "id": "lead-acid-open-circuit-voltage",
      "kind": "real-world",
      "citation": "A rested lead-acid cell's open-circuit voltage is roughly its electrolyte's specific gravity plus 0.84 V. For a VRLA monobloc at 25 °C, published state-of-charge charts give about 12.9 V (2.15 V per cell) at full charge and about 11.8 V (1.97 V per cell) fully discharged. Paraphrased from the lead-acid chapters of Linden's Handbook of Batteries (T. B. Reddy, ed., 4th ed., McGraw-Hill, 2011) and VRLA manufacturers' charts.",
      "covers": [
        "model.params.openCircuitVoltageFullV",
        "model.params.openCircuitVoltageEmptyV"
      ]
    },
    {
      "id": "vrla-internal-resistance",
      "kind": "real-world",
      "citation": "Internal resistance of a fully charged 12 V 7 Ah VRLA battery at 25 °C: about 23 mΩ, mid-range of the class's published datasheets (roughly 17 to 28 mΩ). Those figures are usually 1 kHz AC tester readings, which read lower than the DC resistance a step load sees; F2.4 records using the AC figure as a DC internal resistance as an abstraction.",
      "covers": [
        "model.params.internalResistanceOhm"
      ]
    },
    {
      "id": "terminal-layout",
      "kind": "game-design",
      "citation": "game-design: the two terminals sit on the top of the case, 115 mm apart, chosen for drawing leads; not modelled on a product.",
      "covers": [
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "breaker.saltmere-1p-15a",
  "version": 1,
  "title": "15 A single-pole thermal-magnetic circuit breaker on a base",
  "brand": "Saltmere",
  "modelName": "SB-115",
  "category": "protection",
  "sizeMm": {
    "widthMm": 40,
    "heightMm": 90,
    "depthMm": 70
  },
  "terminals": [
    {
      "id": "line",
      "label": "LINE",
      "positionMm": {
        "x": 20,
        "y": 80,
        "z": 20
      }
    },
    {
      "id": "load",
      "label": "LOAD",
      "positionMm": {
        "x": 20,
        "y": 10,
        "z": 20
      }
    }
  ],
  "model": {
    "kind": "breaker.thermalMagnetic",
    "params": {
      "ratedCurrentA": 15,
      "thermalTimeConstantS": 60,
      "ultimateTripRatio": 1.25,
      "magneticTripMinRatio": 8,
      "magneticTripMaxRatio": 12,
      "contactResistanceOhm": 0.01
    }
  },
  "controls": [
    {
      "id": "on",
      "label": "Handle on",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "molded-case-15a-class",
      "kind": "real-world",
      "citation": "The 15 A single-pole thermal-magnetic molded-case breaker of NEC-region branch circuits, listed to UL 489. Paraphrased, not reproduced: it carries its rating continuously, and must trip within an hour at 135 % (for ratings up to 50 A) and within two minutes at 200 % (up to 30 A). Manufacturers' watts-loss figures put a pole at about 2 W at its rating, about 150 mV, so a contact resistance of 10 mΩ is taken (2.25 W at 15 A).",
      "covers": [
        "model.params.ratedCurrentA",
        "model.params.contactResistanceOhm"
      ]
    },
    {
      "id": "trip-curve-band",
      "kind": "game-design",
      "citation": "game-design inside manufacturer-style curves for NEC-region residential thermal-magnetic breakers (not IEC 60898): inverse-time thermal trips from a little above the rating (ultimate trip 1.25 ×; a 60 s time constant gives about 30 s at 200 %), and an instantaneous magnetic pickup published as a band near ten times the rating (8 to 12 ×, drawn per breaker). The fictional datasheet's band, tested: 135 %: 30 s to 1 h; 200 %: 10 s to 2 min; 500 %: 1 to 15 s; 13 × and above: within 1 ms.",
      "covers": [
        "model.params.thermalTimeConstantS",
        "model.params.ultimateTripRatio",
        "model.params.magneticTripMinRatio",
        "model.params.magneticTripMaxRatio"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: a single-pole breaker on a 40 × 90 mm base, 70 mm tall, with the line terminal at the top and the load terminal at the bottom; standalone (no panel until P4); not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "fuse.emberlyn-5x20-fa-1a",
  "version": 1,
  "title": "1 A fast-acting 5 × 20 mm fuse in an inline holder on a base",
  "brand": "Emberlyn",
  "modelName": "EF-520-1A",
  "category": "protection",
  "sizeMm": {
    "widthMm": 70,
    "heightMm": 30,
    "depthMm": 30
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 8,
        "y": 15,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 62,
        "y": 15,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "fuse",
    "params": {
      "ratedCurrentA": 1,
      "meltingI2tA2s": 0.7,
      "minimumFusingRatio": 1.2,
      "elementFraction": 0.3,
      "bodyTimeConstantS": 10,
      "resistanceOhm": 0.1
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "fast-acting-5x20-class",
      "kind": "real-world",
      "citation": "The 1 A fast-acting 5 × 20 mm glass cartridge fuse, a common supplemental-protection class listed to UL 248-14. Typical published figures for the class, paraphrased (not one vendor's): a cold resistance of about 0.1 Ω and a nominal melting I²t of roughly 0.5 to 1 A²·s (0.7 A²·s is taken).",
      "covers": [
        "model.params.ratedCurrentA",
        "model.params.meltingI2tA2s",
        "model.params.resistanceOhm"
      ]
    },
    {
      "id": "opening-time-band",
      "kind": "game-design",
      "citation": "game-design inside UL 248-14's envelope for supplemental fuses (paraphrased): carries its rating, opens within an hour at 135 % and two minutes at 200 %. The fictional datasheet's band, tested: carries 110 %; 135 %: 1 s to 1 h; 200 %: 0.1 to 5 s; 1000 %: 1 to 20 ms. I_min of 1.2 × the rating, between 1 and 1.35 as the envelope requires.",
      "covers": [
        "model.params.minimumFusingRatio"
      ]
    },
    {
      "id": "two-body-melt",
      "kind": "game-design",
      "citation": "game-design: a fast element taking 30 % of the steady temperature rise inside a slow body (end caps and holder) of 10 s time constant, the element's own time constant (0.151 s) following from the melting I²t (electrical-realism-reviewer's worked example). It gives about 12 s at 135 %, 0.9 s at 200 % and 7 ms at 1000 %, near published fast-acting curves.",
      "covers": [
        "model.params.elementFraction",
        "model.params.bodyTimeConstantS"
      ]
    },
    {
      "id": "holder-layout",
      "kind": "game-design",
      "citation": "game-design: an inline fuse holder on a 70 × 30 mm base, 30 mm tall, with a screw terminal at each end; not modelled on a product. Replacing the fuse in P2 means deleting it and placing a new one.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "heater.hearthvale-12v-50w",
  "version": 1,
  "title": "12 V 50 W heater element on a base",
  "brand": "Hearthvale",
  "modelName": "HV-1250",
  "category": "load",
  "sizeMm": {
    "widthMm": 90,
    "heightMm": 50,
    "depthMm": 40
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 25,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 80,
        "y": 25,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "heater",
    "params": {
      "ratedVoltageV": 12,
      "ratedPowerW": 50
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "low-voltage-heater-class",
      "kind": "real-world",
      "citation": "The 12 V resistance heating element (vehicle and bench heaters, de-icing pads), commonly rated in watts at 12 V; 50 W is a usual rating of the class (typical published figures, paraphrased, not one vendor's). Its resistance is V² / P = 2.88 Ω. A nickel-chromium element's resistance rises only a few percent from cold to hot (a temperature coefficient of about 1e-4 per kelvin), so it is taken as constant at the rated (hot) value.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: the element in a guard on a 90 × 50 mm base, 40 mm tall, with a screw terminal at each end; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "lamp.lumivane-12v-5w",
  "version": 1,
  "title": "12 V 5 W incandescent lamp on a base",
  "brand": "Lumivane",
  "modelName": "LV-12-5",
  "category": "load",
  "sizeMm": {
    "widthMm": 50,
    "heightMm": 50,
    "depthMm": 60
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 25,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 40,
        "y": 25,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "lamp.incandescent",
    "params": {
      "ratedVoltageV": 12,
      "ratedPowerW": 5,
      "filamentRatedTempK": 2700,
      "thermalTimeConstantMs": 50
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "unece-r37-w5w",
      "kind": "real-world",
      "citation": "UN ECE Regulation No. 37 (filament lamps for power-driven vehicles), category W5W: a 12 V wedge-base signal lamp whose 5 W is defined at R37's 13.5 V test voltage. Taking 5 W at 12 V (ratedPowerW at ratedVoltageV) is a game-design simplification. Only the rated values are used; the regulation's text and data sheets are not reproduced.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedPowerW"
      ]
    },
    {
      "id": "filament-temperature",
      "kind": "game-design",
      "citation": "game-design inside published behaviour: small low-voltage vacuum signal lamps run their tungsten filaments at roughly 2500 to 2900 K (lamp makers' miniature-lamp catalogues give colour temperatures in that range; a household 100 W lamp runs nearer 2850 K). 2700 K is taken. With tungsten's resistivity (Jones and Langmuir, 1927) it gives the lamp a cold resistance of about 1/15 of its hot one, which is where the cold-start inrush comes from.",
      "covers": [
        "model.params.filamentRatedTempK"
      ]
    },
    {
      "id": "filament-time-constant",
      "kind": "game-design",
      "citation": "game-design inside published behaviour: a small signal lamp's filament heats and cools in tens of milliseconds, its inrush decaying over a few tens of milliseconds. 50 ms is taken as the small-signal thermal time constant at the rated point; with the 5 W rating it implies about 0.4 mJ/K of heat capacity, a filament of a couple of milligrams of tungsten.",
      "covers": [
        "model.params.thermalTimeConstantMs"
      ]
    },
    {
      "id": "inrush-band",
      "kind": "real-world",
      "citation": "Physics from H. A. Jones and I. Langmuir, General Electric Review 30 (1927): a filament's cold-to-hot resistance ratio is ρ(T_r)/ρ(T_a), 13.5 to 16.1 for rated temperatures of 2500 to 2900 K at a 293 K ambient. The source and lead resistance in series lower the current ratio, so the tested inrush band is 10 to 15 times the settled current.",
      "covers": [
        "model.params.filamentRatedTempK"
      ]
    },
    {
      "id": "holder-layout",
      "kind": "game-design",
      "citation": "game-design: the lamp stands in a holder on a 50 × 50 mm base, 60 mm tall, with a screw terminal on each side of the base; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "lead.quillfern-test-1m",
  "version": 1,
  "title": "1 m 18 AWG test lead with crocodile clips",
  "brand": "Quillfern",
  "modelName": "QF-TL1",
  "category": "lead",
  "sizeMm": null,
  "terminals": [],
  "model": {
    "kind": "lead",
    "params": {
      "lengthMm": 1000,
      "conductorAreaM2": 8.2305e-7,
      "resistivityOhmM": 1.724137931034483e-8,
      "temperatureCoefficientPerK": 0.00393,
      "referenceTemperatureK": 293.15,
      "contactResistanceOhm": 0.01
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "annealed-copper-standard",
      "kind": "real-world",
      "citation": "International Annealed Copper Standard (IEC 60028, 1925): annealed copper has a resistivity of 1/58 Ω·mm²/m (1.7241 × 10⁻⁸ Ω·m) at 20 °C (293.15 K), and a temperature coefficient of resistance of 0.00393 per kelvin at 20 °C. The lead's resistance is computed from these (resistivity × length ÷ area, with the temperature coefficient), never taken from a conductor table.",
      "covers": [
        "model.params.resistivityOhmM",
        "model.params.temperatureCoefficientPerK",
        "model.params.referenceTemperatureK"
      ]
    },
    {
      "id": "awg-18-cross-section",
      "kind": "real-world",
      "citation": "18 AWG, the usual gauge of US bench test leads (NEC/US-first). The area is derived from the public AWG definition (ASTM B258): d = 0.127 mm × 92^((36 − n)/39), so 18 AWG is d ≈ 1.0237 mm and A = π d²/4 ≈ 0.8231 mm² (8.2305e-7 m²); it is not taken from any NEC table. Stranding is ignored: real flexible leads measure about 10 % above this solid-wire figure.",
      "covers": [
        "model.params.conductorAreaM2"
      ]
    },
    {
      "id": "lead-length",
      "kind": "game-design",
      "citation": "game-design: a 1 m bench test lead, a common retail length.",
      "covers": [
        "model.params.lengthMm"
      ]
    },
    {
      "id": "clip-contact-resistance",
      "kind": "real-world",
      "citation": "10 mΩ at each end, where a sprung test clip grips a terminal: typical published test-clip contact ratings are roughly 6 to 15 mΩ (paraphrased from manufacturers' clip specifications; no single vendor).",
      "covers": [
        "model.params.contactResistanceOhm"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "resistor.orrinwood-10r-10w",
  "version": 1,
  "title": "10 Ω 10 W power resistor on a base",
  "brand": "Orrinwood",
  "modelName": "OW-10R-10",
  "category": "load",
  "sizeMm": {
    "widthMm": 70,
    "heightMm": 40,
    "depthMm": 30
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 8,
        "y": 20,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 62,
        "y": 20,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "resistor",
    "params": {
      "resistanceOhm": 10,
      "powerRatingW": 10
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "power-resistor-class",
      "kind": "real-world",
      "citation": "The aluminium-housed wirewound power resistor, a common bench and panel class: 10 Ω in the E-series of preferred values, rated 10 W when mounted on a heat sink (typical published figures for the class, paraphrased, not one vendor's). Its resistance is taken as exact and constant; P2 has no tolerance, temperature coefficient or damage model.",
      "covers": [
        "model.params.resistanceOhm",
        "model.params.powerRatingW"
      ]
    },
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: the resistor on a 70 × 40 mm base, 30 mm tall, with a screw terminal at each end; not modelled on a product.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "supply.brindlecore-bench-30v-5a",
  "version": 1,
  "title": "0–30 V 0–5 A bench DC power supply",
  "brand": "Brindlecore",
  "modelName": "BX-217",
  "category": "source",
  "sizeMm": {
    "widthMm": 130,
    "heightMm": 270,
    "depthMm": 160
  },
  "terminals": [
    {
      "id": "neg",
      "label": "−",
      "positionMm": {
        "x": 56,
        "y": 0,
        "z": 35
      }
    },
    {
      "id": "pos",
      "label": "+",
      "positionMm": {
        "x": 75,
        "y": 0,
        "z": 35
      }
    }
  ],
  "model": {
    "kind": "supply.bench",
    "params": {
      "maxVoltageV": 30,
      "maxCurrentA": 5,
      "outputResistanceOhm": 0.001
    }
  },
  "controls": [
    {
      "id": "setpointV",
      "label": "Voltage",
      "type": "setpoint",
      "unit": "V",
      "min": 0,
      "max": 30,
      "step": 0.01
    },
    {
      "id": "currentLimitA",
      "label": "Current limit",
      "type": "setpoint",
      "unit": "A",
      "min": 0,
      "max": 5,
      "step": 0.001
    },
    {
      "id": "outputOn",
      "label": "Output",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "linear-bench-supply-class",
      "kind": "real-world",
      "citation": "The single-output 0–30 V, 0–5 A linear laboratory supply, a common bench class with constant-voltage and constant-current regulation and automatic crossover. Typical published figures for the class, paraphrased (not one vendor's): CV load regulation within about 0.01 % + 2 mV from no load to full load, so about 5 mV at 30 V over 5 A, an output resistance of about 1 mΩ; case about 130 mm wide, 160 mm tall and 270 mm deep. The size is the footprint on the bench (130 × 270 mm: width, then front to back) and the height above it (160 mm), the bench axes every bench device uses.",
      "covers": [
        "model.params.maxVoltageV",
        "model.params.maxCurrentA",
        "model.params.outputResistanceOhm",
        "sizeMm"
      ]
    },
    {
      "id": "binding-post-layout",
      "kind": "game-design",
      "citation": "game-design: the − and + binding posts sit on the front panel 35 mm above the bench, 19 mm apart (the 0.75 in spacing of dual banana plugs, a common bench convention); the layout is not modelled on a product.",
      "covers": [
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "supply.railwick-din-24v-5a",
  "version": 1,
  "title": "24 V 5 A DIN-rail power supply",
  "brand": "Railwick",
  "modelName": "RW-24-5",
  "category": "source",
  "sizeMm": {
    "widthMm": 40,
    "heightMm": 125,
    "depthMm": 114
  },
  "terminals": [
    {
      "id": "neg",
      "label": "V−",
      "positionMm": {
        "x": 12,
        "y": 112,
        "z": 114
      }
    },
    {
      "id": "pos",
      "label": "V+",
      "positionMm": {
        "x": 28,
        "y": 112,
        "z": 114
      }
    }
  ],
  "model": {
    "kind": "supply.dinPsu",
    "params": {
      "ratedVoltageV": 24,
      "ratedCurrentA": 5,
      "currentLimitA": 6,
      "outputResistanceOhm": 0.048,
      "hiccupDetectMs": 100,
      "hiccupOffMs": 1000
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "din-psu-120w-class",
      "kind": "real-world",
      "citation": "The slim 24 V 5 A (120 W) DIN-rail switch-mode supply, a common control-panel class. Typical published figures, paraphrased (not one vendor's): 24 V DC output, 5 A continuous; load regulation within about ±1 % from no load to full load. The output resistance is the worst-case slope of that band (0.24 V over 5 A, 48 mΩ): the band is a tolerance, and real units typically droop less; body about 40 mm wide, 125 mm tall and 114 mm deep from the rail.",
      "covers": [
        "model.params.ratedVoltageV",
        "model.params.ratedCurrentA",
        "model.params.outputResistanceOhm",
        "sizeMm"
      ]
    },
    {
      "id": "din-psu-overload-protection",
      "kind": "real-world",
      "citation": "Overload protection of the class: a current limit that typically engages between about 105 % and 150 % of the rated current, recovering automatically (hiccup mode) once the fault is removed. 120 % (6 A) is taken, inside that band. Paraphrased from manufacturers' datasheets for the class.",
      "covers": [
        "model.params.currentLimitA"
      ]
    },
    {
      "id": "hiccup-timing",
      "kind": "game-design",
      "citation": "game-design: 100 ms in current limit before the output shuts down, then 1 s off before each restart attempt, a hiccup period of 1.1 s. Datasheets for the class describe hiccup recovery but rarely give its timing; these are chosen to look like it (a short burst, then about a second off).",
      "covers": [
        "model.params.hiccupDetectMs",
        "model.params.hiccupOffMs"
      ]
    },
    {
      "id": "terminal-layout",
      "kind": "game-design",
      "citation": "game-design: the V− and V+ output screw terminals sit on the front face near the top, 16 mm apart; not modelled on a product.",
      "covers": [
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "switch.tessaline-spst-toggle",
  "version": 1,
  "title": "SPST toggle switch on a base",
  "brand": "Tessaline",
  "modelName": "TS-101",
  "category": "switch",
  "sizeMm": {
    "widthMm": 60,
    "heightMm": 40,
    "depthMm": 45
  },
  "terminals": [
    {
      "id": "a",
      "label": "1",
      "positionMm": {
        "x": 10,
        "y": 20,
        "z": 12
      }
    },
    {
      "id": "b",
      "label": "2",
      "positionMm": {
        "x": 50,
        "y": 20,
        "z": 12
      }
    }
  ],
  "model": {
    "kind": "switch.spst",
    "params": {}
  },
  "controls": [
    {
      "id": "closed",
      "label": "Closed",
      "type": "toggle"
    }
  ],
  "sources": [
    {
      "id": "base-layout",
      "kind": "game-design",
      "citation": "game-design: a single-pole, single-throw toggle switch on a 60 × 40 mm base, 45 mm tall, with a screw terminal at each end; not modelled on a product. The switch is ideal in P2 (closed joins its terminals), so it has no electrical parameters yet.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-208y120-150kva",
  "version": 1,
  "title": "208Y/120 V three-phase utility service, 150 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-3W150",
  "category": "source",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "l3",
      "label": "L3",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 350,
        "y": 250,
        "z": 200
      }
    }
  ],
  "model": {
    "kind": "utility.threePhase",
    "params": {
      "ratedKva": 150,
      "percentImpedance": 4,
      "xOverR": 3,
      "lineToNeutralV": 120
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "commercial-transformer-class",
      "kind": "real-world",
      "citation": "A three-phase pad-mounted distribution transformer for a small commercial building: 150 kVA, with an impedance of about 2–5 % and an X/R ratio of about 2–4, typical of published manufacturers' data for the size (paraphrased, not one vendor's). 4 % and an X/R of 3 are taken: per phase 0.04 × (√3 × 120)² / 150 000 = 11.5 mΩ, about 10.4 kA of bolted three-phase fault current, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "wye-208-nominal",
      "kind": "real-world",
      "citation": "120 V from each phase to the neutral of the 208Y/120 V three-phase four-wire nominal system of ANSI C84.1-2020 (the region profile's commercial system); 208 V is the rounded name of 120 × √3 = 207.85 V.",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. Three-phase service is headless in P2 (gameplay is P6), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-480y277-1000kva",
  "version": 1,
  "title": "480Y/277 V three-phase utility service, 1000 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-3W1000",
  "category": "source",
  "sizeMm": {
    "widthMm": 400,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "l3",
      "label": "L3",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 350,
        "y": 250,
        "z": 200
      }
    }
  ],
  "model": {
    "kind": "utility.threePhase",
    "params": {
      "ratedKva": 1000,
      "percentImpedance": 5.75,
      "xOverR": 6,
      "lineToNeutralV": 277
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "industrial-transformer-class",
      "kind": "real-world",
      "citation": "A three-phase liquid-filled substation or pad-mounted transformer for an industrial plant: 1000 kVA, with an impedance of 5.75 %, a long-standing typical value for the size, and an X/R ratio of about 5–7, from published manufacturers' data and short-circuit study guides (paraphrased, not one vendor's). An X/R of 6 is taken: per phase 0.0575 × (√3 × 277)² / 1 000 000 = 13.2 mΩ, about 20.9 kA of bolted three-phase fault current, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "wye-480-nominal",
      "kind": "real-world",
      "citation": "277 V from each phase to the neutral of the 480Y/277 V three-phase four-wire nominal system of ANSI C84.1-2020 (the region profile's industrial system); 480 V is the rounded name of 277 × √3 = 479.78 V.",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. Three-phase service is headless in P2 (gameplay is P6), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
},
{
  "id": "utility.larkmoor-split-phase-25kva",
  "version": 1,
  "title": "120/240 V split-phase utility service, 25 kVA transformer",
  "brand": "Larkmoor Power",
  "modelName": "LP-SP25",
  "category": "source",
  "sizeMm": {
    "widthMm": 300,
    "heightMm": 300,
    "depthMm": 200
  },
  "terminals": [
    {
      "id": "l1",
      "label": "L1",
      "positionMm": {
        "x": 50,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "l2",
      "label": "L2",
      "positionMm": {
        "x": 250,
        "y": 250,
        "z": 200
      }
    },
    {
      "id": "n",
      "label": "N",
      "positionMm": {
        "x": 150,
        "y": 250,
        "z": 200
      }
    }
  ],
  "model": {
    "kind": "utility.splitPhase",
    "params": {
      "ratedKva": 25,
      "percentImpedance": 2,
      "xOverR": 2,
      "lineToNeutralV": 120
    }
  },
  "controls": [],
  "sources": [
    {
      "id": "pole-transformer-class",
      "kind": "real-world",
      "citation": "A single-phase overhead (pole-mounted) distribution transformer serving a house: 25 kVA is a common size for one to a few homes, with an impedance of about 1.5–3 % and an X/R ratio of about 1–3, typical of published manufacturers' data and utility service guides for small single-phase units (paraphrased, not one vendor's). 2 % and an X/R of 2 are taken: a full-winding impedance of 0.02 × 240² / 25 000 = 46.1 mΩ, about 5.2 kA of bolted fault current across L1–L2, the infinite-primary (transformer-limited) available fault current: an upper bound, with no utility system impedance.",
      "covers": [
        "model.params.ratedKva",
        "model.params.percentImpedance",
        "model.params.xOverR"
      ]
    },
    {
      "id": "split-phase-nominal",
      "kind": "real-world",
      "citation": "120 V from each line to the neutral (the secondary's centre tap), the 120/240 V single-phase three-wire nominal system of ANSI C84.1-2020 (the region profile's split-phase system).",
      "covers": [
        "model.params.lineToNeutralV"
      ]
    },
    {
      "id": "headless-layout",
      "kind": "game-design",
      "citation": "game-design: a placeholder size and terminal layout. The service is headless in P2 (no service entrance or meter base until P4), so it is not drawn.",
      "covers": [
        "sizeMm",
        "terminals"
      ]
    }
  ],
  "extensions": {}
}
];
