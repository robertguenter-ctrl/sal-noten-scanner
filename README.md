# SAL Noten-Scanner (PWA)

Handy-PWA: Kamera → OCR der SAL-Notenübersicht auf dem Laptop → BL-Laufbahncheck.

- **3. Klasse:** Übertritt FMS/Gym (§§ 51/53)
- **1./2. Klasse:** Beförderung (§§ 41–42) und Aufstieg Leistungszug (§ 45; Punkteformel je Klasse unterschiedlich)

Schwesterprojekt zum Bookmarklet-Dashboard:
[`sal-noten-dashboard`](https://github.com/robertguenter-ctrl/sal-noten-dashboard)

## Lokal

```bash
cd sal-noten-scanner
python3 -m http.server 8787
```

Dann `http://localhost:8787` auf dem Handy im gleichen Netz öffnen (Kamera braucht HTTPS oder localhost).

## Deploy (Vercel)

1. Dieses Repo auf GitHub verbinden  
2. Neues Vercel-Project (Framework: Other, kein Build)  
3. Domain z. B. `sal-noten-scanner.vercel.app`

## Hinweis

OCR vom Bildschirm ist heuristisch — erkannte Noten immer prüfen. Für den Desktop bleibt das Bookmarklet zuverlässiger.
