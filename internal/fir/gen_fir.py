#!/usr/bin/env python3
"""Génère internal/fir/fir_world.geojson à partir du shapefile FIR/UIR officiel
d'EUROCONTROL (atlas euctrl-pru, dérivé de l'EAD — European AIS Database).

Contrairement à son nom, le jeu EAD couvre le **monde entier** : 336 FIR/UIR
OACI réelles (271 FIR + 65 UIR), en WGS84, à ~667 points/zone — bien plus
précis que l'ancienne source VATSIM (1038 secteurs de simulation, ~20 pts/zone,
contours en lignes droites grossières). Les frontières continentales épousent
ainsi les frontières administratives des États, comme dans la réalité.

Source   : https://github.com/euctrl-pru/eurocontrol-atlas (zip/FirUir_EAD.zip)
Licence  : MIT (repo atlas) — données EAD EUROCONTROL, millésime 2015-04-30.
Schéma de sortie (consommé par web/src/components/FirLayer.tsx & co.) :
    properties = { icao: IDENT, name: NAME, type: "FIR"|"UIR", uir: bool }

Prérequis : pip install pyshp shapely  (idéalement dans un venv).
Usage     : python3 internal/fir/gen_fir.py
            (re-télécharge le zip dans un cache temporaire si absent)

Le contour est simplifié à TOL degrés (~500 m) : invisible à l'échelle d'une
carte de FIR, mais ramène le fichier de 4.7 Mo (brut) à ~1 Mo.
"""
import io
import json
import os
import urllib.request
import zipfile

import shapefile  # pyshp
from shapely.geometry import mapping, shape

SRC_URL = "https://raw.githubusercontent.com/euctrl-pru/eurocontrol-atlas/master/zip/FirUir_EAD.zip"
TOL = 0.005          # tolérance de simplification (degrés ; ~500 m)
NDIGITS = 5          # arrondi des coordonnées (~1 m)
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fir_world.geojson")
CACHE = os.path.join("/tmp", "FirUir_EAD.zip")


def load_zip_bytes() -> bytes:
    if os.path.exists(CACHE):
        with open(CACHE, "rb") as f:
            return f.read()
    data = urllib.request.urlopen(SRC_URL, timeout=120).read()
    with open(CACHE, "wb") as f:
        f.write(data)
    return data


def main() -> None:
    zf = zipfile.ZipFile(io.BytesIO(load_zip_bytes()))
    base = "FirUir_EAD/FirUir_EAD"
    reader = shapefile.Reader(
        shp=io.BytesIO(zf.read(base + ".shp")),
        dbf=io.BytesIO(zf.read(base + ".dbf")),
        shx=io.BytesIO(zf.read(base + ".shx")),
    )
    fields = [f[0] for f in reader.fields[1:]]

    def round_coords(o):
        if isinstance(o, (list, tuple)):
            return [round_coords(x) for x in o]
        return round(o, NDIGITS)

    feats = []
    for sr in reader.shapeRecords():
        rec = dict(zip(fields, sr.record))
        geom = shape(sr.shape.__geo_interface__)
        if not geom.is_valid:
            geom = geom.buffer(0)
        geom = geom.simplify(TOL, preserve_topology=True)
        if geom.is_empty:
            continue
        gj = mapping(geom)
        gj["coordinates"] = round_coords(gj["coordinates"])
        feats.append({
            "type": "Feature",
            "properties": {
                "icao": rec["IDENT"],
                "name": rec["NAME"],
                "type": rec["TYPE"],
                "uir": rec["TYPE"] == "UIR",
            },
            "geometry": gj,
        })

    fc = {"type": "FeatureCollection", "features": feats}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(fc, f, separators=(",", ":"), ensure_ascii=False)
    size = os.path.getsize(OUT)
    print(f"écrit {OUT} : {len(feats)} FIR/UIR, {size / 1024:.0f} Ko")


if __name__ == "__main__":
    main()
