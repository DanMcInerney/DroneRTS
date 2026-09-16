"""Build client-only ground artwork geometry from an official OSM XML extract.

Offline: .venv/Scripts/python.exe scripts/build-ground.py
Refresh: .venv/Scripts/python.exe scripts/build-ground.py --download --accessed YYYY-MM-DD
The XML cache is ignored; the compact, attributed derived JSON is checked in.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import urllib.request
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
URL = "https://api.openstreetmap.org/api/0.6/map?bbox=-84.524,39.094,-84.501,39.1085"


def tags(element):
    return {tag.attrib["k"]: tag.attrib["v"] for tag in element.findall("tag")}


def at_ground(properties, identifier=""):
    # Fountain Square's plaza is tagged layer=1 above its underground garage,
    # but is the walkable outdoor surface already represented by this game.
    if identifier == "osm-1515580379":
        return True
    if properties.get("bridge", "no") != "no" or properties.get("tunnel", "no") != "no":
        return False
    if properties.get("location") in {"underground", "roof", "rooftop"}:
        return False
    if properties.get("indoor", "no") != "no" or properties.get("covered") == "yes":
        return False
    for key in ("layer", "level"):
        value = properties.get(key)
        if value:
            try:
                if any(float(part) != 0 for part in value.split(";")):
                    return False
            except ValueError:
                return False
    return True


def classify(properties, identifier):
    if not at_ground(properties, identifier):
        return None
    # Satellite inspection shows paved promenades around the separately mapped
    # P&G lawns, and a paved private fountain court south of Government Square.
    if (properties.get("name") == "Elm Street Plaza"
        or identifier in {"osm-39866974", "osm-relation-20284511"}):
        return "plaza"
    if properties.get("amenity") == "parking":
        if properties.get("parking") in {"underground", "multi-storey", "rooftop"}:
            return None
        if properties.get("building", "no") != "no":
            return None
        return "parking"
    if properties.get("highway") == "pedestrian" and (
        properties.get("area") == "yes" or properties.get("type") == "multipolygon"
    ):
        return "plaza"
    if (properties.get("leisure") in {"park", "garden"}
        or properties.get("landuse") in {"grass", "meadow", "forest", "recreation_ground"}
        or properties.get("landcover") == "grass"):
        return "grass"
    return None


def area(points):
    return abs(sum(a["x"] * b["z"] - b["x"] * a["z"]
                   for a, b in zip(points, points[1:] + points[:1]))) / 2


def inside(point, ring):
    result = False
    previous = ring[-1]
    for current in ring:
        if ((current["z"] > point["z"]) != (previous["z"] > point["z"])) and (
            point["x"] < (previous["x"] - current["x"]) *
            (point["z"] - current["z"]) / (previous["z"] - current["z"]) + current["x"]
        ):
            result = not result
        previous = current
    return result


def clean(points):
    result = []
    for point in points:
        rounded = {axis: round(point[axis], 4) for axis in ("x", "z")}
        if not result or rounded != result[-1]:
            result.append(rounded)
    if len(result) > 1 and result[-1] == result[0]:
        result.pop()
    return result


def clip_polygon(points, bounds):
    result = points
    for axis in ("x", "z"):
        for bound, sign in ((bounds[axis][0], 1), (bounds[axis][1], -1)):
            old, result = result, []
            if not old:
                break
            previous = old[-1]
            for current in old:
                pin = sign * (previous[axis] - bound) >= 0
                cin = sign * (current[axis] - bound) >= 0
                if pin != cin:
                    ratio = (bound - previous[axis]) / (current[axis] - previous[axis])
                    result.append({key: previous[key] + ratio * (current[key] - previous[key])
                                   for key in ("x", "z")})
                if cin:
                    result.append(current)
                previous = current
    result = clean(result)
    return result if len(result) >= 3 and area(result) > 0.0001 else []


def clip_line(points, bounds):
    """Liang-Barsky segments; keep distinct runs when a path leaves the crop."""
    runs, run = [], []
    for first, second in zip(points, points[1:]):
        t0, t1 = 0.0, 1.0
        dx, dz = second["x"] - first["x"], second["z"] - first["z"]
        constraints = [(-dx, first["x"] - bounds["x"][0]),
                       (dx, bounds["x"][1] - first["x"]),
                       (-dz, first["z"] - bounds["z"][0]),
                       (dz, bounds["z"][1] - first["z"])]
        valid = True
        for p, q in constraints:
            if p == 0:
                if q < 0:
                    valid = False
                    break
            elif p < 0:
                t0 = max(t0, q / p)
            else:
                t1 = min(t1, q / p)
        if not valid or t0 > t1:
            if len(run) > 1:
                runs.append(run)
            run = []
            continue
        a = {"x": round(first["x"] + t0 * dx, 4), "z": round(first["z"] + t0 * dz, 4)}
        b = {"x": round(first["x"] + t1 * dx, 4), "z": round(first["z"] + t1 * dz, 4)}
        if run and run[-1] != a:
            if len(run) > 1:
                runs.append(run)
            run = []
        if not run:
            run.append(a)
        if b != run[-1]:
            run.append(b)
    if len(run) > 1:
        runs.append(run)
    return runs


def join_rings(segments):
    pending = [list(segment) for segment in segments]
    rings = []
    while pending:
        ring = pending.pop(0)
        while ring[0] != ring[-1]:
            found = False
            for index, segment in enumerate(pending):
                if ring[-1] == segment[0]:
                    ring += segment[1:]
                elif ring[-1] == segment[-1]:
                    ring += segment[-2::-1]
                elif ring[0] == segment[-1]:
                    ring = segment[:-1] + ring
                elif ring[0] == segment[0]:
                    ring = segment[:0:-1] + ring
                else:
                    continue
                pending.pop(index)
                found = True
                break
            if not found:
                return None
        rings.append(ring)
    return rings


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("input", nargs="?", type=Path, default=ROOT / ".runtime/cincinnati-ground.osm")
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--accessed", default="2026-09-16")
    parser.add_argument("--output", type=Path, default=ROOT / "client/assets/cincinnati-ground.json")
    args = parser.parse_args()
    if args.download:
        args.input.parent.mkdir(parents=True, exist_ok=True)
        request = urllib.request.Request(URL, headers={"User-Agent": "DroneRTS-ground-builder/1.0"})
        with urllib.request.urlopen(request, timeout=45) as response:
            args.input.write_bytes(response.read())
    if not args.input.exists():
        parser.error("No cached OSM XML. Supply a saved extract or use --download --accessed YYYY-MM-DD.")

    research = json.loads((ROOT / "city-research.json").read_text())
    projection, origin = research["projection"], research["origin"]
    scale = projection["recommendedGameUnitsPerMeter"]

    def project(point):
        return {"x": (point["lon"] - origin["lon"]) * projection["metersPerDegreeLongitude"] * scale,
                "z": (origin["lat"] - point["lat"]) * projection["metersPerDegreeLatitude"] * scale}

    geo_bounds = research["bounds"]
    northwest = project({"lon": geo_bounds["west"], "lat": geo_bounds["north"]})
    southeast = project({"lon": geo_bounds["east"], "lat": geo_bounds["south"]})
    bounds = {axis: [round(northwest[axis], 4), round(southeast[axis], 4)] for axis in ("x", "z")}
    tree = ET.parse(args.input).getroot()
    nodes = {element.attrib["id"]: project({"lat": float(element.attrib["lat"]),
                                           "lon": float(element.attrib["lon"])})
             for element in tree.findall("node")}
    ways = {element.attrib["id"]: element for element in tree.findall("way")}
    references = {identifier: [node.attrib["ref"] for node in element.findall("nd")]
                  for identifier, element in ways.items()}
    areas, paths, trees, used, incomplete = [], [], [], set(), []

    def add_area(identifier, properties, kind, outer, holes=()):
        points = clip_polygon(outer, bounds)
        if not points:
            return
        item = {"id": identifier, "name": properties.get("name", ""), "kind": kind, "points": points}
        clipped_holes = [clip_polygon(hole, bounds) for hole in holes]
        clipped_holes = [hole for hole in clipped_holes if hole]
        if clipped_holes:
            item["holes"] = clipped_holes
        if properties.get("surface"):
            item["surface"] = properties["surface"]
        if kind == "grass":
            item["detail"] = ("lawn" if properties.get("landuse") in {"grass", "meadow"}
                              or properties.get("landcover") == "grass" else
                              "garden" if properties.get("leisure") == "garden" else "park")
        areas.append(item)

    for relation in tree.findall("relation"):
        properties = tags(relation)
        identifier = "osm-relation-" + relation.attrib["id"]
        kind = classify(properties, identifier)
        if properties.get("type") != "multipolygon" or not kind:
            continue
        members = [member for member in relation.findall("member") if member.attrib["type"] == "way"]
        if any(member.attrib["ref"] not in references for member in members):
            incomplete.append(identifier)
            continue
        groups = {role: join_rings([references[member.attrib["ref"]] for member in members
                                   if member.attrib.get("role", "outer") in roles])
                  for role, roles in (("outer", {"outer", ""}), ("inner", {"inner"}))}
        if groups["outer"] is None or groups["inner"] is None or not groups["outer"]:
            incomplete.append(identifier)
            continue
        if any(ref not in nodes for rings in groups.values() for ring in rings for ref in ring):
            incomplete.append(identifier)
            continue
        inners = [[nodes[ref] for ref in ring[:-1]] for ring in groups["inner"]]
        for index, ring in enumerate(groups["outer"]):
            outer = [nodes[ref] for ref in ring[:-1]]
            holes = [hole for hole in inners if inside(hole[0], outer)]
            suffix = f"-{index}" if len(groups["outer"]) > 1 else ""
            add_area(identifier + suffix, properties, kind, outer, holes)
        used.update(member.attrib["ref"] for member in members if member.attrib.get("role", "outer") != "inner")

    for identifier, element in ways.items():
        properties, refs = tags(element), references[identifier]
        key = "osm-" + identifier
        if len(refs) < 2 or any(ref not in nodes for ref in refs):
            continue
        kind = classify(properties, key)
        if kind and identifier not in used and len(refs) >= 4 and refs[0] == refs[-1]:
            add_area(key, properties, kind, [nodes[ref] for ref in refs[:-1]])
        highway = properties.get("highway")
        if (highway not in {"footway", "path", "pedestrian", "steps", "service"}
            or properties.get("area") == "yes" or kind == "plaza" or not at_ground(properties, key)):
            continue
        path_kind = "service" if highway == "service" else "path"
        default_width = 5 if properties.get("service") == "parking_aisle" else 3.5 if path_kind == "service" else 2
        try:
            width = float(properties.get("width", default_width))
        except ValueError:
            width = default_width
        width = round(min(12, max(0.8, width)) * scale, 3)
        for index, points in enumerate(clip_line([nodes[ref] for ref in refs], bounds)):
            item = {"id": f"{key}-{index}", "kind": path_kind, "width": width, "points": points}
            if properties.get("surface"):
                item["surface"] = properties["surface"]
            paths.append(item)

    for element in tree.findall("node"):
        properties, point = tags(element), nodes[element.attrib["id"]]
        if properties.get("natural") == "tree" and at_ground(properties):
            if all(bounds[axis][0] <= point[axis] <= bounds[axis][1] for axis in ("x", "z")):
                trees.append({"id": "osm-node-" + element.attrib["id"], **clean([point])[0]})

    roads, roofs, water = [], [], []
    for road in research["roads"]:
        for index, points in enumerate(clip_line([project(p) for p in road["points"]], bounds)):
            roads.append({"id": f'{road["id"]}-{index}', "name": road["name"],
                          "width": round(road["widthM"] * scale, 3), "kind": road.get("kind", "road"), "points": points})
    footprint_ids = set()
    for building in research["landmarks"] + research["buildings"]:
        identity = building.get("osmId", building["id"])
        if identity in footprint_ids or not building.get("footprint"):
            continue
        footprint_ids.add(identity)
        points = clip_polygon([project(p) for p in building["footprint"]], bounds)
        if points:
            roofs.append({"id": building["id"], "points": points})
    river = json.loads((ROOT / "riverfront-source.json").read_text())
    river_rings = [clip_polygon([project({"lon": p[0], "lat": p[1]}) for p in ring], bounds)
                   for ring in river["waterRings"]]
    river_rings = sorted((ring for ring in river_rings if ring), key=area, reverse=True)
    for ring in river_rings:
        parent = next((polygon for polygon in reversed(water) if inside(ring[0], polygon["points"])), None)
        if parent:
            parent.setdefault("holes", []).append(ring)
        else:
            water.append({"points": ring})

    areas.sort(key=lambda item: (item["kind"], -area(item["points"]), item["id"]))
    result = {"source": {"url": URL, "accessed": args.accessed,
               "inputSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
               "attribution": "Map data © OpenStreetMap contributors", "license": "ODbL 1.0",
               "licenseUrl": "https://www.openstreetmap.org/copyright",
               "projection": {"origin": origin, "gameUnitsPerMeter": scale,
                              "metersPerDegreeLatitude": projection["metersPerDegreeLatitude"],
                              "metersPerDegreeLongitude": projection["metersPerDegreeLongitude"]},
               "roadsAndRoofs": "city-research.json, acquired 2026-09-14",
               "water": {"url": river["sourceUrl"], "accessed": river["acquiredAt"], "imagery": river["sourceImagery"]},
               "notes": ["Client-only rendering metadata; never expose to drone actors.",
                         "Ground flattened. Park outlines include both planting and paving; explicit lawns and pedestrian areas refine them.",
                         "Unmapped surface finishes, tree sizes, road and path widths are artistic approximations.",
                         "Roofs are context footprint artwork for outside the active arena only; no added collision geometry.",
                         "Fountain Square outdoor plaza layer 1 is retained above its garage; other elevated or underground ground features are excluded."],
               "incompleteRelationsOmitted": incomplete},
              "bounds": bounds, "areas": areas, "paths": paths, "trees": trees,
              "roads": roads, "roofs": roofs, "water": water}
    validate(result)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "bytes": args.output.stat().st_size,
                      "counts": {key: len(result[key]) for key in ("areas", "paths", "trees", "roads", "roofs", "water")},
                      "incompleteRelations": incomplete}))


def validate(data):
    identifiers = [item["id"] for item in data["areas"]]
    assert len(identifiers) == len(set(identifiers)), "Duplicate area identifiers"
    for item in data["areas"]:
        assert item["kind"] in {"grass", "parking", "plaza"}
        assert area(item["points"]) > 0
    for collection in ("areas", "paths", "roads", "roofs", "water"):
        for item in data[collection]:
            for ring in [item["points"], *item.get("holes", [])]:
                for point in ring:
                    for axis in ("x", "z"):
                        assert math.isfinite(point[axis])
                        assert data["bounds"][axis][0] <= point[axis] <= data["bounds"][axis][1]
    by_id = {item["id"]: item for item in data["areas"]}
    assert by_id["osm-1452793527"]["kind"] == "plaza", "Elm Street Plaza is paved"
    assert by_id["osm-39866974"]["kind"] == "plaza", "Private fountain court is paved"
    assert any(identifier.startswith("osm-relation-20284511") for identifier in by_id), "Full P&G Gardens multipolygon must be preserved"
    assert any(item["id"].startswith("osm-relation-20284512") for item in data["areas"]), "P&G lawns missing"


if __name__ == "__main__":
    main()
