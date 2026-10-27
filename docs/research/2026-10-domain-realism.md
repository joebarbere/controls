> Research snapshot gathered 2026-10-26 by a planning sub-agent for controls-development-plan.md. Versions, licences and figures were verified on that date; re-verify before relying on them.

# Electrician / Industrial Automation Sim: Domain Research Report (2026-10-26)

**Sources:** The game and trainer findings come from web research. Many of the standards sources I found were vendor blogs, and some of them disagreed with each other. Before you lock content, check the numbers against the current editions: NEC 2026, NFPA 70E 2024, NFPA 79, IEC 60204-1, IEC 60947-4-1 and IEC 60898. Where a figure comes from general trade knowledge rather than a source I fetched, the text says so.

---

## Part A: Existing games and trainers

| Title                                                                                  | Does well                                                                                                                                                                                                                              | Criticized / gaps                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Electrician Simulator** (Take IT Studio, 2022; free prologue _First Shock_; VR port) | Breaker labelling and fault-finding as a puzzle; logical checklist-style jobs; good tutorials; zoom and auto-aim on small parts. Mostly Positive on Steam.                                                                             | EU fittings only, which confuses US and UK players. Users say "no distinction between live, neutral and earth wires." Installations are pristine, unlike real jobs. Too much appliance repair (5/10 OpenCritic review). Fiddly controls, inconsistent interactivity, clipping while running cable. Players asked for ground-fault hunts, pump and motor installs, box and conduit fill, wire and breaker sizing, service entrances, and a choice of residential, commercial, industrial or lineman work. |
| **Shenzhen I/O** (Zachtronics)                                                         | Datasheets and a manual as the core mechanic; real constraints; optimization histograms. Overwhelmingly Positive.                                                                                                                      | Steep curve; reviewers note it uses a dense manual instead of a tutorial. Abstract electronics, not trade work.                                                                                                                                                                                                                                                                                                                                                                                          |
| **"Automation"** (ladder-logic game, 2015, Windows)                                    | Teaches ladder logic on machines inspired by real factory equipment.                                                                                                                                                                   | Small niche. I only saw third-party listings, not the Steam page itself.                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Factory I/O** (Real Games)                                                           | 3D conveyor and sorting scenes; connects to real PLCs and simulators (S7-PLCSIM, Modbus, CODESYS); cheap; widely used in classrooms.                                                                                                   | Purely logic-level I/O: you never wire anything. On the forum, users asked for cylinders with home and work end-position sensors, called the missing end switches "not according to industry standards", and reported sensor timing that lags with large I/O counts or low fps.                                                                                                                                                                                                                          |
| **LogixPro** (The Learning Pit)                                                        | Mimics the RSLogix 500 interface with canned scenarios (traffic light, batch mixer, elevator, bottle line). Inexpensive.                                                                                                               | Dated; logic only; no electrical layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **CADe SIMU** (free, Spanish-origin)                                                   | Fast drag-and-drop of contactor, relay and motor circuits with animated simulation. Studies credit it with narrowing the theory-practice gap through unlimited experiments and immediate feedback.                                     | Simplified, idealized behavior. I found no independent critique; most material is in Spanish.                                                                                                                                                                                                                                                                                                                                                                                                            |
| **EKTS** (free, Windows)                                                               | Relays, timers, buttons, motors, plus toy mechanisms (garage door, elevator). Its error-pointing feature shows where an error is and why.                                                                                              | Does not calculate current flow or power distribution, so results can differ from reality.                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Automation Studio** (Famic)                                                          | The deepest of the software tools: electrical, PLC, hydraulics and pneumatics; virtual multimeter, clamp meter and oscilloscope; instructor-set faults.                                                                                | Expensive. CAD-like UX, not a game.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Amatrol FaultPro / Festo LabVolt 8036** (real hardware)                              | Real panels with fault insertion under instructor control. Amatrol can fault even full-power motor lines and scores 0-4 based on the number of tries and the time taken. LabVolt hides up to 4 faults per module behind the faceplate. | Hardware cost and seat limits.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**Gaps a realistic game could fill:**

1. **One layer from wire to logic.** Factory I/O and LogixPro have logic but no wiring. Electrician Simulator has hands-on work but no circuit physics. Nobody combines physically wiring a PNP sensor into a sinking card with the ladder logic that then fails because of it.
2. **A real circuit solver**, so meters read actual voltages, currents and resistances, including stray voltage and voltage under load. EKTS and CADe SIMU don't calculate this.
3. **Selectable code regions** (NEC/US vs IEC/EU), covering fittings, wire colors, symbols and voltages.
4. **Messy brownfield sites:** mislabelled breakers, previous-owner hacks, outdated drawings.
5. **Sizing and code checks as gameplay:** ampacity, voltage drop, box and conduit fill, overload settings.
6. **Safety procedure as a real mechanic**, not a cutscene: LOTO, test-before-touch, PPE.
7. **FaultPro-style scoring** on time, tries, parts swapped needlessly, and safety violations.

---

## Part B: Realism checklist

Format: **Item**: what to simulate / what to abstract.

### Tier 1: Basics

- **Hand tools**
  - Strippers and gauge holes: simulate nicked strands from the wrong hole (adds resistance and a hot spot). Abstract the motion to a single action.
  - Crimpers and ferrules: simulate the right die per terminal type, and a pull test that fails on a bad crimp.
  - Torque screwdrivers: simulate the spec, with under-torque leading to a later high-resistance fault. Abstract the exact in-lb figures to a green zone.
  - Fish tape: abstract to a mini-game.
- **Meters and CAT ratings**
  - Simulate the rating rule: CAT II for receptacle loads, CAT III for panels, motors and distribution, CAT IV at the service origin and meter. Using an under-rated meter or test leads at a service is a safety penalty. ([Fluke](https://content.fluke.com/pdf/catalog/catalog-eng/files/assets/basic-html/page12.html))
  - Simulate the usual meter mistakes: leads left in the amps jack and then put across a voltage (blown fuse or arc), ghost voltage on high-impedance meters, and the low-impedance (LoZ) mode that removes it.
- **Non-contact voltage tester (NCVT):** simulate false negatives (shielded cable, dead battery) and false positives (induced voltage). It teaches that an NCVT is only a screening tool.
- **Clamp meter:** simulate that clamping both conductors reads about zero. Also simulate inrush mode and DC clamps.
- **Insulation tester (megger):** simulate the test voltage (500 or 1000 V), the pass threshold (about 1 MΩ or more as a game rule), the need to disconnect electronics first (or you damage the VFD and PLC), and moisture degrading readings.
- **Loop / continuity / RCD tester:** for the IEC region, simulate earth fault loop impedance (Zs) against breaker curve limits. For the US region, abstract it to a ground continuity check.
- **Wire types**
  - THHN/THWN: 90°C dry, conductors pulled in conduit.
  - NM-B: residential cable, ampacity limited to the 60°C column.
  - MTW: machine tool wire under NFPA 79.
  - Flexible stranded wire needs ferrules, which are mandatory in practice for IEC spring terminals.
- **Color codes**
  - US: white or gray grounded (neutral) conductor, green or bare ground (EGC), and orange for the high-leg (these are code requirements). Black/red/blue for 208/120 V and brown/orange/yellow for 480/277 V are convention.
  - IEC 60445: L1 brown, L2 black, L3 grey, N blue, PE green-yellow.
  - Machine control colors per NFPA 79 and IEC 60204-1: red for AC control, blue for DC control. Conductors that stay energized when the main disconnect is off are yellow in the US and orange under IEC. ([NFPA 79 colors](https://www.automation.com/article/standard-nfpa-wire-colors), [IEC](https://industrialmonitordirect.com/blogs/knowledgebase/european-control-panel-wire-colour-codes-per-iec-60204-1))
  - Simulate color as information, not physics: a miscolored wire works electrically but misleads the next technician, which makes a great trap.
- **Gauge, ampacity and voltage drop**
  - Simulate a lookup in an NEC 310.16-style table plus derating for conduit fill and ambient temperature.
  - Simulate the small-conductor caps: 14 AWG on 15 A, 12 on 20 A, 10 on 30 A.
  - Simulate voltage drop computed from length and current, using the 3% branch / 5% total guidance (an informational note, not a requirement). Show it as dim lights and motors that won't start.
  - Abstract the full 310.15 calculation into an in-game reference book.
- **Terminations:** simulate loose connections (heat, then intermittent faults, then arcing), aluminum on a non-CO/ALR device, too many conductors under one screw, and back-stab failures.
- **Power sources** (simulate all with real phase angles)
  - 120/240 V split-phase.
  - 208Y/120 V: line-to-line is 208, not 240, so a 240 V heater runs at about 75% power.
  - 480Y/277 V.
  - 230/400 V (IEC).
  - DC 24 V control supplies: polarity, current capacity (amps) and inrush limits.
  - Batteries.
  - Generators: transfer switch and backfeed danger.
  - Abstract utility-side detail beyond the service point.
- **Overcurrent protection**
  - Simulate breaker magnetic bands: B trips at 3-5×In, C at 5-10×In, D at 10-20×In. The thermal limits are no trip at 1.13×In within 1 h and a trip at 1.45×In within 1 h. A motor nuisance-tripping a B-curve breaker is a good scenario. ([IEC 60898 table](https://storage.electrika.com/flips/6090-havells-homesafe-13/files/assets/basic-html/page-18.html))
  - Fuses: US classes CC/J/RK1/RK5/T and IEC gG/aM. Simulate time-delay vs fast-acting and interrupting rating. Abstract full time-current curves to "too fast / OK / too slow."
  - GFCI/RCD: simulate the 5 mA (US) or 30 mA (IEC) trip, nuisance trips caused by a shared neutral, and the test button.
  - AFCI: abstract it; real arc signatures are proprietary.
- **Grounding and bonding:** simulate the main bonding jumper only at the service, and the objectionable current from a neutral-to-ground bond in a subpanel. With no ground path, nothing trips and the enclosure goes live. This is a core lesson.
- **Switches:** single-pole, 3-way (travelers), 4-way. Simulate miswired travelers. Also switch-loop re-identification of the white conductor.
- **Lights and receptacles:** simulate reversed polarity (detected by a plug-in tester), open ground, and shared neutrals in multiwire branch circuits (MWBC). Losing the neutral on an MWBC causes overvoltage on one leg, a memorable fault.

### Tier 2: Industrial

- **Motors**
  - Nameplate fields: voltage, FLA, SF, code letter, RPM, frame, duty, efficiency.
  - Simulate LRA as about 6-8× FLA, rotation reversal by swapping any 2 phases, wye/delta dual-voltage lead connections (T1-T9 / U1-W2), and star-delta starting at about 1/3 starting torque and current.
  - Single-phase motors: start capacitor and centrifugal switch failures.
  - Abstract the torque-speed curve to a few states.
- **Pumps:** simulate a simplified pump curve vs system curve, dry-run seal damage (needs a float or pressure permissive), dead-heading, and water hammer. Abstract hydraulics to flow and head numbers.
- **Actuators:** solenoid valves (coil voltage, AC vs DC coils, a burned coil from a stuck spool), 5/2 vs 5/3 valves, cylinders with reed switches, linear actuators with limit switches. Simulate air pressure as a simple resource.
- **Sensors**
  - Simulate the NPN (sinking) vs PNP (sourcing) mismatch with the input card. This is the single best "wrong sensor type" puzzle.
  - 2-wire leakage current causing a false-on (for example into a PLC input).
  - Sensing ranges: inductive senses metal only; capacitive also detects the tank wall.
  - Photoelectric modes: through-beam, retroreflective, diffuse.
  - 4-20 mA loops: simulate that 0 mA means a broken wire and 4 mA is live zero; loop power; 2-wire vs 4-wire transmitters.
  - RTD (resistance about 100 Ω at 0°C) and thermocouples: simulate wrong-type extension wire and reversed polarity.
  - Also float and pressure switches.
- **Control relays and contactors**
  - Simulate the coil voltage on the nameplate (a 24 VDC coil on 120 VAC burns out; 120 V on 240 V burns out quickly; 240 V on 120 V chatters or won't pull in), aux contacts (NO/NC, 13-14 / 21-22 numbering), and AC-3 ratings vs AC-1.
  - Simulate welded contacts from undersizing or jogging.
- **Overload relays:** simulate the trip class by trip time at 7.2× the setting current: Class 10 at 4-10 s (10A at 2-10 s), Class 20 at 6-20 s, Class 30 at 9-30 s. Simulate the dial set to FLA (not to the breaker rating), manual vs auto reset, and phase-loss sensitivity. ([Schneider](https://www.productinfo.schneider-electric.com/9065ct9701_catalog/9065ct9701-overload-relays-and-thermal-units-catalog/English/9065CT9701%20Overload%20Relays%20and%20Thermal%20Units_0000354340.xml/$/TripClassDesignation-2A6DF6B0), [ABB](https://www.rgbautomatyka.pl/de/p/file/40edb0b8429ea945e87b671ed9cc227c/ABB_TA75DU52_58_1_2.pdf)) The 1.5× check figures and the NEMA 600% convention can be abstracted.
- **Timers:** on-delay, off-delay (which needs a control voltage supply or a trigger input), interval, recycle, and multifunction dial units. Simulate the dial settings.
- **Control circuits**
  - 3-wire start/stop with seal-in.
  - Jog with a selector, so the seal-in is defeated.
  - Forward/reverse with electrical interlocks (NC aux contacts) and mechanical interlocks.
  - 2-wire control, with automatic restart after a power loss as a hazard.
  - E-stop: Category 0 removes power immediately; Category 1 is a controlled stop, then power is removed; Category 2 is a controlled stop with power kept. The category is chosen by risk assessment, and an E-stop overrides everything. ([Schneider FAQ](https://www.se.com/ae/en/faqs/FA225420), [Machinery Safety 101](https://machinerysafety101.com/series/emergency-stop/))
  - Abstract safety-relay internals to a block with dual channels and monitored reset.
- **VFDs and soft starters (later tier):** simulate parameter entry from the nameplate, fault codes (OC, OV, UV, ground fault), and that you must not put a contactor between drive and motor or megger through the drive. Abstract PWM and harmonics.
- **PLC I/O:** simulate sinking vs sourcing cards, the common terminals (COM, 0V/M), relay vs transistor outputs, fusing, analog scaling, and a scan cycle. Tag-level ladder logic is enough; abstract vendor IDEs.
- **SCADA/HMI:** abstract to tag binding, alarms and trends. Polling and timing are fun later.

### Tier 3: Safety and fault realism

- **LOTO:** simulate the sequence: notify, identify all energy sources (including air, springs and gravity), shut down, isolate, lock and tag, release stored energy, verify. A missed second source, such as a control circuit fed from another panel (the yellow/orange wires), is a key scenario.
- **Test before touch:** simulate the live-dead-live check (prove the tester on a known source, test, prove it again). Skipping it is the top penalty.
- **NFPA 70E arc flash**
  - Simulate the PPE category method: Cat 1 = 4, Cat 2 = 8, Cat 3 = 25, Cat 4 = 40 cal/cm², and above 40 you de-energize. Read panel arc flash labels, and use limited and restricted approach boundaries. ([summary](https://industrialmonitordirect.com/it/blogs/knowledgebase/nfpa-70e-ppe-levels-vs-incident-energy-selection-guide)) This source conflicts on table numbering, so confirm it in 70E 2024.
  - Abstract incident-energy calculation (IEEE 1584) to label values.
  - Justified energized work only (energized work permit).
- **Shock:** model body current = V / (body + contact resistance), with wet and sweaty skin lowering resistance. Use 60 Hz thresholds: about 1 mA perception; about 10-16 mA let-go (Dalziel's let-go figures: men about 16 mA, women about 10.5 mA); about 50-100 mA or more for fibrillation risk. ([Hubbell](https://hubbellcdn.com/literature/07-0801-02.pdf), [UMN notes](https://www.d.umn.edu/~sburns/EE2212/L-Safe-Levels-of-Current-in-the-Human-Body.pdf)) A GFCI or RCD saves you. Keep consequences non-graphic: injury states, a medical leave timer, and reputation and licence strikes.
- **Fault library** (each with a measurable signature)
  - Open: full voltage across the break, zero current.
  - Short: instant trip; low resistance when tested de-energized.
  - Ground fault: GFCI trip; megger reads low insulation to ground.
  - High-resistance connection: voltage drop under load only, heat (IR camera as a later tool).
  - Failed coil: open or shorted coil resistance.
  - Welded contacts: motor won't stop; the mechanical interlock saves you.
  - Phase loss / single-phasing: motor hums, overload trips, unbalanced clamp reading.
  - Wrong sensor type: PNP sensor on a sinking card stays dark.
  - Also: blown control fuse, tripped overload, dirty photo-eye lens, mis-set timer, wrong rotation.

### Tier 4: Diagram standards

- **Symbols:** ANSI/JIC/NEMA (circle coils "M", "CR"; horizontal ladder rungs) vs IEC 60617 (rectangle coils "-K1", "-Q1"; vertical current paths, device tags per IEC 81346). Simulate a toggle for which convention the drawing set uses. Reading the other region's prints is a later-career skill.
- **Ladder diagram conventions:** L1 on the left rail, L2/N on the right, coil at the right end, rungs numbered with cross-references to contact locations. IEC sheets use column/row cross-references.
- **Wire numbering:** wire numbers by rung number or potential, terminal strips (X1:1...), and field vs panel wiring. Simulate "as-built differs from print" as a fault type.
- **Panel layout:** DIN rail, duct fill, separating power and control (24 V vs 120/480 V), main disconnect, and short-circuit current rating (SCCR). Abstract the UL 508A SCCR calculation to a pass/fail checklist.
- **Standards scope:**
  - NFPA 79 / IEC 60204-1: machine electrical equipment (colors, stop categories, disconnects, protective bonding).
  - UL 508A: building industrial control panels.
  - Present these as inspections and audits rather than reading assignments.

---

## Recommended progression

1. **Apprentice (residential/light commercial, 120/240 V):**
   - Skills: tools, NCVT, multimeter, CAT ratings, test-before-touch.
   - Work: receptacles and switches (including 3-way and 4-way), GFCI/AFCI, panel circuit tracing, ampacity lookups.
   - Supervised: the journeyman catches mistakes and halves the penalty.
2. **Journeyman (commercial/light industrial, 208/480 V three-phase):**
   - Electrical: conduit and THHN, voltage drop, motors and contactors, 3-wire control, overloads, reversing, LOTO.
   - Testing and safety: megger, clamp meter, arc flash labels, NEC vs IEC jobs abroad.
   - Diagnosis: troubleshooting from prints.
3. **Master / foreman:**
   - Design and code: service and panel design, load calcs, SCCR and coordination.
   - Business: crew management (assign apprentices), bidding, inspections.
4. **Controls technician → controls engineer:**
   - Wiring: sensors (NPN/PNP, 4-20 mA), PLC I/O wiring, then ladder logic.
   - Later systems: VFDs, safety relays and stop categories, HMI/SCADA, panel building to UL 508A and NFPA 79.
   - Commissioning: whole lines.

## Starter scenarios / jobs

1. "Dead outlet in the kitchen": a tripped GFCI downstream in another room.
2. A 3-way switch swap where the previous owner miswired the travelers.
3. Mislabelled panel: trace and label every breaker (the praised Electrician Simulator mechanic, made harder).
4. A 240 V water heater that heats slowly: it's on a 208 V commercial service.
5. Garage subpanel with a neutral-to-ground bond: tingle from the metal door.
6. Basement sump pump replacement: float switch, dry-run, dedicated circuit (a request from players).
7. Shop conveyor won't start: overload dial set wrong, then a tripped overload.
8. Install a forward/reverse starter with interlocks for an overhead door.
9. A new PNP photo-eye on an old sinking PLC card stays dark.
10. Pump station: a 4-20 mA level transmitter reads 0 mA (broken loop wire) and the alarm floods the HMI.
11. Three-phase motor overheating and humming: blown fuse, single-phasing.
12. LOTO a mixer with a second energy source (pneumatics, or a separately fed control circuit).
13. Megger a wet motor before restart after a flood.
14. Read an IEC drawing set for a European-built machine at a US plant (with the NFPA 79 color conflict).

Scoring idea, borrowed from Amatrol: time, number of tries, parts replaced needlessly, and safety violations, which carry the heaviest weight.

**Key URLs:**

- Electrician Simulator: [Steam](https://store.steampowered.com/app/1080020), [realism thread](https://steamcommunity.com/app/1080020/discussions/0/3453716776424425170), [GameCell review](https://gamecell.co.uk/reviews/electrician-simulator), [OpenCritic](https://opencritic.com/game/13824/electrician-simulator/reviews)
- Shenzhen I/O: [Wikipedia](https://en.wikipedia.org/wiki/Shenzhen_I/O)
- Factory I/O: [wishlist forum](https://community.factoryio.com/t/the-big-factory-i-o-wishlist-discussion/136), [Control.com](https://control.com/technical-articles/factory-i-o-a-modern-plc-simulation-tool-to-learn-the-fundamentals/)
- LogixPro: [overview](https://industrialmonitordirect.com/blogs/knowledgebase/logixpro-plc-simulator-for-allen-bradley-practice)
- EKTS: [AlternativeTo](https://alternativeto.net/software/ekts-electrical-control-techniques-simulator-/about/)
- Automation Studio: [Famic](https://www.famictech.com/en/Products/Automation-Studio/Educational-Edition)
- Amatrol FaultPro: [product page](https://amatrol.com/product/electric-motor-control-troubleshooting/)
- LabVolt 8036: [Festo](https://labvolt.festo.com/solutions/6_power_energy/98-8036-00_industrial_controls_training_systems)
- Ladder-logic game "Automation": [MobyGames](https://www.mobygames.com/game/221203/automation/)
