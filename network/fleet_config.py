"""Validate fleet configuration supplied by the Node composition root.

There is no Python default roster: every helper runs only the supplied members.
"""

import json
import re


def parse_roster(raw):
    members = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(members, list) or not 1 <= len(members) <= 254:
        raise ValueError("Fleet roster must contain 1–254 members")
    identities, systems = {}, set()
    for member in members:
        if not isinstance(member, dict):
            raise ValueError("Invalid fleet member")
        drone, system = member.get("id"), member.get("systemId")
        if (not isinstance(drone, str) or not re.fullmatch(r"drone-[1-9]\d*", drone)
                or int(drone[6:]) > 9007199254740991 or drone in identities):
            raise ValueError("Invalid or duplicate fleet drone identity")
        if type(system) is not int or not 1 <= system <= 254 or system in systems:
            raise ValueError("Invalid or duplicate MAVLink system ID")
        identities[drone] = system
        systems.add(system)
    return identities
