> Research snapshot gathered 2026-10-26 by a planning sub-agent for controls-development-plan.md. Versions, licences and figures were verified on that date; re-verify before relying on them.

I put together the research report below from about 25 web searches and page fetches. Licenses, archive status, stack and dependency details come from each project's own GitHub page or package.json. Items I could not check are marked "unverified" in the notes.

# Open-source industrial automation for an Electron/Angular/Three.js electrician game

## 1. Project survey

**OpenPLC (Autonomy Logic)**

- **v3** (https://github.com/thiagoralves/OpenPLC_v3): GPL-3.0, C++ and Python, compiled with MatIEC. It was **archived on 2026-04-04 and is end-of-life**. CVE-2026-14480 (authenticated arbitrary file write in the v3 web UI) was published in July 2026 (https://www.incibe.es/incibe-cert/alerta-temprana/avisos-sci/escritura-arbitraria-de-archivos-en-productos-de-openplc). Use it only as a conceptual reference.
- **Runtime v4** (https://github.com/Autonomy-Logic/openplc-runtime): **MIT**. It runs as two processes: a C/C++ scan engine at SCHED_FIFO real-time priority, and a Python/Flask REST and Socket.IO debug server that talk over Unix sockets. Protocols such as Modbus slave, S7comm and EtherCAT are plugins. It has no web UI; the desktop editor drives it.
- **Editor v4** (https://github.com/Autonomy-Logic/openplc-editor): **GPL-3.0**, version 4.3.2 in package.json. The stack is Electron, React 18, TypeScript, @xyflow/react (ladder/FBD canvas), Monaco (ST), zustand, fast-xml-parser and xmlbuilder2. Projects are saved as **PLCopen TC6 XML**.
  - It is the closest existing match to your architecture. Copy its ideas, not its code, unless the game is GPL.
- **Worth borrowing:** the IEC located-variable addressing (%IX0.0, %QX0.0, %IW0, %QW0, %MW0) and its fixed mapping onto Modbus coils, discrete inputs and registers. The "editor compiles, runtime loads" split is also a good model.

**STruC++** (https://github.com/Autonomy-Logic/STruCpp)

- TypeScript on Node 18+. The README says it "runs in any JavaScript environment… browsers". API: `import { compile } from "strucpp"`.
- Compiles **ST only** to C++ (the README says C++14). It covers most of IEC 61131-3 Edition 3, CODESYS-style OOP, a unit-test mode and a REPL, with 1400+ tests and active development.
- License: **GPL-3.0 compiler**, plus a runtime-library exception for the generated C++.
- It is the successor to MatIEC inside OpenPLC v4.
- For the game: its parser and type checker could be studied. It emits C++, though, so you would still need your own TS backend. Bundling it makes your editor GPL.

**MatIEC / Beremiz** (https://github.com/beremiz/beremiz)

- Python IDE and C runtime. Licenses: IDE GPLv2+, Python runtime LGPLv2+, C runtime GPLv3+. MatIEC (iec2c) is GPL.
- Mature and actively committed, but not usable from TS.
- Worth borrowing: the PLCopen XML project model and the POU/resource/task/configuration hierarchy.

**Other compilers**

- RuSTy (https://github.com/PLC-lang/rusty): Rust and LLVM, LGPL-3.0/GPL-3.0, ST only. A possible future path is ST to WASM, but that is heavy.
- esstee (https://github.com/knordman/esstee): a GPLv3 ST interpreter in C.
- I found **no mature JS/TS ST interpreter**. You will write your own, which is reasonable in scope.

**JS/TS ladder editors and simulators.** None are mature or reusable as libraries.

- **Studomate** (https://github.com/vporel/studomate): TypeScript, Next.js, React 19, React Flow. It covers ladder, GRAFCET, a simple HMI, and step or continuous simulation, and saves versioned JSON with migrations. Active in 2026, but **AGPL-3.0**: read it for UX ideas only, never copy code.
- MBLogic's old SVG/JS web ladder editor (SourceForge) is a dated reference.
- @vitormnm/node-red-instructions-ladder-iec-61131-3 adds ladder-style instructions inside Node-RED.
- s7-server (npm) is an MIT TypeScript simulator of the S7 protocol, not of ladder.
- Conclusion: build your own rung renderer. Grid-based SVG or canvas is better than free-form graph nodes.

**PLCopen XML (TC6 v2.01 → IEC 61131-10:2019)** (https://www.plcopen.org/system/files/downloads/tc6_xml_v201_technical_doc.pdf, https://plcopen.org/node/519)

- Open XSD that covers configurations, data types and POUs in IL, ST, LD, FBD and SFC. Graphical languages are stored as nodes with `localId` and explicit connections plus x/y positions.
- Beremiz, OpenPLC and CODESYS import and export it, though vendor dialects differ.

**FUXA** (https://github.com/frangoteam/FUXA, docs https://frangoteam.github.io/FUXA/)

- **MIT**, about 5.2k stars, active. Angular front end with an SVG editor, Node back end.
- Split into FUXA-editor and FUXA-view. Device and tag model with drivers for Modbus RTU/TCP, S7, OPC UA, BACnet, MQTT, Ethernet/IP and others. Includes a historian (SQLite/InfluxDB), chart controls, alarms and scripts.
- **The most relevant reference for you:** same framework, permissive license, so you can legally lift components or patterns with attribution. It is an app, not a library, so expect to extract and adapt rather than `npm install`.
- Its alarm docs are a how-to I did not open. From memory (unverified): severity levels high-high, high, low and info, with acknowledge.

**Rapid SCADA 6** (https://github.com/RapidScada/scada-v6)

- C#/.NET, Apache-2.0 core; some add-on modules are proprietary.
- Not usable from TS. Its clean separation of Server, Communicator (drivers) and Webstation, and its channel/archive/event model, are good architecture references.

**ScadaBR**

- Java. Last release 1.2 (2021). Licensing is listed as GPLv2/MIT with no clear split.
- Effectively stagnant. Its Mango-derived "data source → data point → event detector" model is a useful concept.

**Node-RED Dashboard 2.0** (https://dashboard.flowfuse.com)

- Package @flowfuse/node-red-dashboard. The old Angular-1 dashboard was deprecated in June 2024.
- Ideas to borrow: a flow-based logic layer, and widgets (gauge, chart, button) that bind to message topics. From memory: built on Vue/Vuetify with eCharts (unverified).

**node-opcua** (https://www.npmjs.com/package/node-opcua)

- **MIT**, TypeScript, actively released (2.175.x in July 2026). Full client and server with address-space modelling.
- Node-only, so it must run in Electron's main or utility process.

**Modbus for Node**

- **modbus-serial** (https://github.com/yaacov/node-modbus-serial): ISC, ships .d.ts types. `ServerTCP(vector, {port, unitID})` takes `getCoil`, `getHoldingRegister`, `setRegister` and `setCoil` callbacks, which is ideal for exposing game tags. Serial support is optional.
- **jsmodbus** (https://github.com/Cloud-Automation/node-modbus): MIT. v4 has long been an "early beta" with 2017-era CI, so maintenance looks doubtful. Prefer modbus-serial.

**Commercial tools (inspiration only)**

- **Factory I/O:** a 3D factory scene whose sensors and actuators map to PLC I/O through driver tabs (PLCSIM, Modbus, OPC). Your Three.js plant is this concept.
- **CADe SIMU:** a 2D schematic editor and simulator for contactors, relays and motor starters. This is your electrician layer: wiring a hardwired starter before replacing it with a PLC.
- **PLCSIM:** emulates a PLC in software, so the same program runs without hardware, with a watch/force table. This is your Web Worker PLC.

## 2. Recommendations

**Licensing posture.** Keep the game proprietary-safe:

- Freely usable: MIT (FUXA, OpenPLC runtime v4, node-opcua, jsmodbus) and ISC (modbus-serial).
- Treat as read-only references: GPL (OpenPLC editor, STruC++, MatIEC, Beremiz) and AGPL (Studomate). Don't bundle or copy them unless you open-source the game under a compatible license.

**PLC scan cycle in a Web Worker**

- One dedicated Worker per PLC. The tag memory is a `SharedArrayBuffer`: typed-array regions for I, Q, M, timers and counters, laid out at fixed offsets so %IX/%QW addresses resolve to byte and bit indexes. Electron needs COOP/COEP headers, or use `postMessage` snapshots as a fallback.
- Each scan:
  1. Copy the physical-input image from the sim into I.
  2. Execute the POUs in task order.
  3. Copy Q out to the output image.
  4. Service comms and the debug/watch snapshot.
  5. Update a watchdog and scan-time stats.
- Drive it with a **simulated clock, not `setTimeout`**: the main sim sends `tick(dtMs)`, the PLC advances its virtual time and runs N scans. This gives deterministic replays, pause and step, and 10× time.
- Expose RUN, STOP and PROGRAM modes, a first-scan bit, faults (watchdog, divide-by-zero, array bounds), forcing, and online-edit "accept rung".
- Compile programs to an intermediate representation. A simple stack VM or closures is plenty fast in a JIT. Do not use `eval` of player text.
- Instruction set v1, using AB-style names for player familiarity with IEC equivalents:
  - Bits: XIC, XIO, OTE, OTL, OTU, ONS/R_TRIG.
  - Timers: TON, TOF, RTO (retentive, with RES).
  - Counters: CTU, CTD, CTUD.
  - Compare: EQU, NEQ, GRT, LES, GEQ, LEQ, LIM.
  - Math: ADD, SUB, MUL, DIV, MOD, SQR.
  - Data: MOV, MVM, COP, CLR; BTD later.
  - Later: SCP (scaling), PID, JSR, MCR.

**Language order**

1. **Ladder (LD) first.** It is what electricians recognise and it maps onto the wiring they just did. Render rungs on a strict grid of cells with series and parallel branches. It is easier to validate and to animate power flow than a free-form graph.
2. **ST second.** Write a small hand-made recursive-descent parser in TS for expressions, IF/CASE/FOR/WHILE, FB instances and user-defined types, using Monaco for editing. The same IR also gives you FBD cheaply.
3. **FBD third**, using a node editor.
4. **SFC/GRAFCET last**, for sequencing levels such as batch tanks. Skip IL; it was deprecated in Edition 3.

**Storage**

- Native format: versioned JSON (as Studomate does) with schema migrations and zod validation.
- Add **PLCopen XML import/export** as a feature. Map the LD, FBD and SFC graphs to TC6 `<LD>`/`<FBD>`/`<SFC>` with localIds and connections, and ST bodies to `<ST>`, using fast-xml-parser or xmlbuilder2.
- Test round-trips against Beremiz and the OpenPLC editor. Players could then move a program to a real OpenPLC, which is a strong educational hook.

**In-game networking**

- Build a simulated network bus in the main/sim thread. Devices (PLCs, HMIs, VFDs, remote I/O) have IPs and unit IDs. Cables and switches in the 3D world gate connectivity, so a broken cable means a timeout.
- Model Modbus TCP at the PDU level: function codes 1–6, 15 and 16, exception codes, latency, and timeouts. Use the same `vector` interface shape as modbus-serial so a real server can be swapped in.
- For OPC UA in-game, a simplified browse/read/write/subscribe model over the tag database is enough. Don't emulate the binary protocol.
- **Optional real exposure:** in Electron's main or utility process, run modbus-serial `ServerTCP` and/or a node-opcua server backed by the shared tag memory. Off by default, bound to 127.0.0.1, and opt-in in settings. Players could then connect real tools such as Ignition, FUXA, QModMaster or UaExpert. Show a security warning for LAN binding.

**SCADA/HMI builder in Angular**

- Model it on FUXA's editor/runtime split:
  - A **screen document**: JSON with an SVG canvas of widgets placed by x/y/w/h.
  - A **widget library**: Angular standalone components with typed `@Input` bindings. Examples are pushbutton (momentary or maintained), indicator lamp, numeric display and entry, gauge, tank fill, motor and valve symbols with state animation, trend, and alarm banner.
  - A **properties panel** generated from widget metadata.
- **Tag binding:** a central TagService with signals or RxJS that subscribes by tag path (`PLC1:Program:Motor1.Run`). Bindings can carry expressions such as scaling, threshold-to-colour, and visibility. HMI writes go through the simulated network, so comms faults surface realistically.
- **Alarms:** follow the ISA-18.2 lifecycle: normal → unacknowledged active → acknowledged active → returned-unacknowledged → normal. Add priority (1–4), deadband, on-delay, shelving, and an alarm summary and history table.
- **Trends:** a ring-buffer historian per tag with deadband or sample-rate logging, in IndexedDB for saves. Plot real-time and historical pens with uPlot or eCharts.
- Navigation: screen-change buttons and popups (faceplates).
- Later, add user and security levels and simple scripts for on-click or on-tag-change behaviour, through a sandboxed expression evaluator.

Sources:

- [OpenPLC v3 (archived)](https://github.com/thiagoralves/OpenPLC_v3)
- [openplc-runtime](https://github.com/Autonomy-Logic/openplc-runtime)
- [openplc-editor](https://github.com/Autonomy-Logic/openplc-editor)
- [STruCpp](https://github.com/Autonomy-Logic/STruCpp)
- [INCIBE CVE-2026-14480](https://www.incibe.es/incibe-cert/alerta-temprana/avisos-sci/escritura-arbitraria-de-archivos-en-productos-de-openplc)
- [Beremiz](https://github.com/beremiz/beremiz)
- [RuSTy](https://github.com/PLC-lang/rusty)
- [esstee](https://github.com/knordman/esstee)
- [Studomate](https://github.com/vporel/studomate)
- [PLCopen TC6 v2.01](https://www.plcopen.org/system/files/downloads/tc6_xml_v201_technical_doc.pdf)
- [IEC 61131-10](https://plcopen.org/node/519)
- [FUXA](https://github.com/frangoteam/FUXA)
- [FUXA docs](https://frangoteam.github.io/FUXA/)
- [Rapid SCADA v6](https://github.com/RapidScada/scada-v6)
- [ScadaBR](https://www.LIMSwiki.org/index.php/ScadaBR)
- [Node-RED Dashboard 2.0](https://dashboard.flowfuse.com/getting-started.html)
- [node-opcua](https://npmjs.org/package/node-opcua)
- [modbus-serial](https://github.com/yaacov/node-modbus-serial)
- [jsmodbus](https://github.com/Cloud-Automation/node-modbus)
- [node-modbus (deprecated)](https://npmjs.com/package/node-modbus)
- [ladder node for Node-RED](https://flows.nodered.org/node/@vitormnm/node-red-instructions-ladder-iec-61131-3)
- [s7-server](https://www.jsdelivr.com/package/npm/s7-server)

## Notes

- **Not verified directly:** the OpenPLC Runtime v4 version (v4.1.4 comes from a mirror page, not upstream release notes), FUXA's alarm severity levels, Node-RED Dashboard 2.0's Vue/eCharts stack, the Factory I/O, CADe SIMU and PLCSIM summaries, and OpenPLC v3's %IX/%QX-to-Modbus address mapping. These are from memory or secondary sources. Check them before relying on them.
- **No JS/TS ST interpreter or ladder library turned up.** The search was limited to GitHub and npm queries plus aggregator pages (the ecosyste.ms ladder-logic topic page returned 403), so a smaller project may exist.
