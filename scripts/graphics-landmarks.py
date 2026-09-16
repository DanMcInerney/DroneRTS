"""Original façade details from September 2026 Street View/reference inspection.

All details are skins on the sourced boxes. Arched windows and crown ribs have
opaque backing, not fly-through openings. See GRAPHICS.md for exact references.
"""
import math


def landmark_style(identifier):
    if identifier == 'great-american-tower-crown':
        return 'tiara'
    if identifier.startswith('great-american-tower'):
        return 'silver-glass'
    if identifier.startswith('carew') or identifier == 'netherland-plaza':
        return 'carew'
    if identifier.startswith('fourth-vine'):
        return 'limestone'
    if identifier == 'fifth-third-center':
        return 'fifth-third'
    return None


def detail_face(building, style, face, across, columns, batch, transform, panel, mats):
    h, w, d = building['height'], building['width'], building['depth']
    base = building.get('baseY', 0)
    bay = across / columns
    stone, brick, recess, metal, glass = (mats[k] for k in ['stone', 'brick', 'recess', 'metal', 'glass'])

    def point(u, y, offset=.004):
        return transform([(u, y, d/2+offset), (w/2+offset, y, -u),
                          (-u, y, -d/2-offset), (-w/2-offset, y, u)][face])

    def stroke(a, b, width, mat, offset=.004):
        dx, dy = b[0]-a[0], b[1]-a[1]
        length = math.hypot(dx, dy)
        if not length:
            return
        nx, ny = -dy/length*width/2, dx/length*width/2
        batch.quad([point(u,y,offset) for u,y in [(a[0]-nx,a[1]-ny), (b[0]-nx,b[1]-ny),
                   (b[0]+nx,b[1]+ny), (a[0]+nx,a[1]+ny)]], mat)

    if style == 'carew':
        # Continuous buff piers and recessed sash stacks, with ornament reserved
        # for setbacks/crown instead of repetitive horizontal office-block bands.
        for col in range(columns+1):
            u = max(-across/2+.025, min(across/2-.025, -across/2+col*bay))
            panel(u, h/2, .036, h-.06, brick, .003)
        panel(0, h-.055, across, .065, brick, .003)
        panel(0, h-.12, across, .023, recess, .0033)
        for col in range(columns):
            u = -across/2+(col+.5)*bay
            for n in [-1,0,1]:
                panel(u+n*.036, h-.19, .012, .09, stone, .0035)
        if base == 0:
            podium = min(1.1,h*.16)
            panel(0,podium/2,across,podium,stone,.004)
            panel(0,.08,across,.16,recess,.0042)
            bays = max(2,round(across/.64))
            for col in range(bays):
                u=-across/2+(col+.5)*across/bays
                panel(u,podium*.44,across/bays*.69,podium*.69,recess,.0045)
                panel(u,podium*.44,.018,podium*.69,metal,.005)
                panel(u,podium*.58,across/bays*.69,.014,metal,.005)
                # Three small Art Deco rays above each arcade storefront.
                for dx in [-.065,0,.065]:
                    stroke((u,podium*.81),(u+dx,podium*.94),.012,brick,.005)
            panel(0,podium-.02,across,.038,brick,.005)

    elif style == 'limestone':
        panel(0,h-.055,across,.075,stone,.003)
        panel(0,h-.12,across,.022,recess,.0034)
        # Cream stone corner quoins, evenly spaced recessed sash windows.
        for sign in [-1,1]:
            panel(sign*(across/2-.065),h/2,.13,h,stone,.003)
            for n in range(int(h/.16)):
                panel(sign*(across/2-.065),.08+n*.16,.13,.007,recess,.0034)
        if base == 0:
            podium=1.8
            panel(0,podium/2,across,podium,stone,.004)
            for y in [.08+i*.14 for i in range(13)]:
                panel(0,y,across,.008,recess,.0042)
            bays=max(3,round(across/.68))
            for col in range(bays):
                u=-across/2+(col+.5)*across/bays
                radius=across/bays*.32
                spring=1.13
                # One closed opaque arched window, with stone voussoir edging.
                outline=[(u-radius,.24),(u+radius,.24),(u+radius,spring)]
                outline += [(u+math.cos(a)*radius,spring+math.sin(a)*radius) for a in [i*math.pi/12 for i in range(1,13)]]
                batch.quad([point(x,y,.005) for x,y in outline],recess,[(0,0)]*len(outline))
                for i in range(12):
                    a,b=i*math.pi/12,(i+1)*math.pi/12
                    stroke((u+math.cos(a)*(radius+.023),spring+math.sin(a)*(radius+.023)),
                           (u+math.cos(b)*(radius+.023),spring+math.sin(b)*(radius+.023)),.023,brick,.0053)
                panel(u,.69,.016,.9,metal,.0055)
                panel(u,.73,radius*2,.025,metal,.0055)
                panel(u,.26,radius*2+.045,.035,stone,.0058)
            panel(0,podium-.04,across,.09,stone,.006)
            # Small dark dentils make the heavy cornice legible at street scale.
            for col in range(columns*2):
                panel(-across/2+(col+.5)*across/(columns*2),podium-.1,.021,.028,recess,.0062)

    elif style == 'fifth-third':
        # The tower's defining close-set uninterrupted pale concrete fins.
        for col in range(columns+1):
            u=max(-across/2+.024,min(across/2-.024,-across/2+col*bay))
            panel(u,h/2,.037,h,stone,.003)
            panel(u+.022,h/2,.010,h,recess,.0033)
        panel(0,h-.028,across,.055,stone,.004)
        panel(0,.22,across,.44,recess,.004)
        for col in range(columns+1):
            u=max(-across/2+.025,min(across/2-.025,-across/2+col*bay))
            panel(u,.22,.048,.44,stone,.005)

    elif style == 'silver-glass':
        for col in range(columns+1):
            u=max(-across/2+.024,min(across/2-.024,-across/2+col*bay))
            panel(u,h/2,.033 if col%3 else .06,h,metal,.003)
        # Broader silver strips flank the dark central window stacks.
        for sign in [-1,1]:
            panel(sign*across*.28,h/2,.085,h,metal,.0035)
        if base == 0:
            panel(0,.40,across,.80,glass,.0035)
            for col in range(max(2,round(across/.55))+1):
                u=-across/2+col*across/max(2,round(across/.55))
                panel(max(-across/2+.035,min(across/2-.035,u)),.4,.07,.8,stone,.004)
            panel(0,.79,across,.055,stone,.004)

    elif style == 'tiara':
        panel(0,h/2,across,h,glass,.002)
        # Arching tiara ribs as a flush, opaque-backed crown skin. Silhouette
        # stays the documented simplified solid box used by sensors/collision.
        for arc in [.67,.88]:
            points=[(-across*.48+i*across*.96/24, h*.10+arc*h*math.sin(math.pi*i/24)) for i in range(25)]
            for a,b in zip(points,points[1:]):
                stroke(a,b,.045,stone)
        for col in range(13):
            t=col/12
            u=(t-.5)*across*.94
            top=h*.10+.88*h*math.sin(math.pi*t)
            stroke((u,.05),(u,top),.026,metal)
            if col<12:
                nxt=((t+1/12)-.5)*across*.94
                stroke((u,.06),(nxt,h*.1+.67*h*math.sin(math.pi*(t+1/12))),.014,stone,.0045)
        panel(0,.04,across,.08,stone,.005)
