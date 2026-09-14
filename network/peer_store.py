"""One peer's durable delivery state. Consumed rows remain as deduplication tombstones."""

import json
import sqlite3
import threading


def encode(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False)


class PeerStore:
    def __init__(self, path, drone, session):
        self.lock = threading.RLock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA synchronous=FULL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS identity (drone TEXT, session TEXT);
            CREATE TABLE IF NOT EXISTS outbox (
                id TEXT PRIMARY KEY, message TEXT NOT NULL, recipients TEXT NOT NULL,
                receipts TEXT NOT NULL DEFAULT '[]', expires REAL NOT NULL,
                next_attempt REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'pending'
            );
            CREATE TABLE IF NOT EXISTS inbox (
                sender TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL,
                expires REAL NOT NULL DEFAULT 0,
                consumed INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sender, id)
            );
        """)
        with self.lock:
            owner = self.db.execute("SELECT * FROM identity").fetchone()
            if owner and (owner["drone"] != drone or owner["session"] != session):
                self.db.close()
                raise ValueError("Store belongs to another drone or fleet session")
            if not owner:
                with self.db:
                    self.db.execute("INSERT INTO identity VALUES (?, ?)", (drone, session))
            if "expires" not in {row["name"] for row in self.db.execute("PRAGMA table_info(inbox)")}:
                # Old development stores have no recoverable envelope expiry. Surface
                # those rows as expired, so the model boundary can report and consume them.
                with self.db:
                    self.db.execute("ALTER TABLE inbox ADD COLUMN expires REAL NOT NULL DEFAULT 0")

    def queue(self, message, recipients, expires):
        body = encode(message)
        with self.lock, self.db:
            existing = self.db.execute("SELECT message FROM outbox WHERE id=?", (message["id"],)).fetchone()
            if existing:
                if existing["message"] != body:
                    raise ValueError("Message ID already exists with different contents")
                return
            self.db.execute("INSERT INTO outbox(id,message,recipients,expires) VALUES(?,?,?,?)",
                            (message["id"], body, encode(recipients), expires))

    def accept(self, message, expires):
        body = encode(message)
        with self.lock, self.db:
            existing = self.db.execute("SELECT message FROM inbox WHERE sender=? AND id=?",
                                       (message["from"], message["id"])).fetchone()
            if existing:
                if existing["message"] != body:
                    raise ValueError("Conflicting duplicate message")
                return False
            self.db.execute("INSERT INTO inbox(sender,id,message,expires) VALUES(?,?,?,?)",
                            (message["from"], message["id"], body, expires))
            return True

    def acknowledge(self, message_id, recipient, now):
        with self.lock, self.db:
            row = self.db.execute("SELECT * FROM outbox WHERE id=? AND status='pending'",
                                  (message_id,)).fetchone()
            if not row or row["expires"] <= now:
                return None
            recipients, receipts = json.loads(row["recipients"]), json.loads(row["receipts"])
            if recipient not in recipients or recipient in receipts:
                return None
            receipts.append(recipient)
            complete = set(receipts) == set(recipients)
            self.db.execute("UPDATE outbox SET receipts=?, status=? WHERE id=?",
                            (encode(sorted(receipts)), "received" if complete else "pending", message_id))
            return recipients if complete else None

    def expire(self, now):
        with self.lock, self.db:
            rows = self.db.execute("SELECT id,recipients,receipts FROM outbox WHERE status='pending' AND expires<=?",
                                   (now,)).fetchall()
            self.db.execute("UPDATE outbox SET status='expired' WHERE status='pending' AND expires<=?", (now,))
            return [dict(row) for row in rows]

    def due(self, now):
        with self.lock:
            return [dict(row) for row in self.db.execute(
                "SELECT * FROM outbox WHERE status='pending' AND expires>? AND next_attempt<=?", (now, now))]

    def attempted(self, message_id, now):
        with self.lock, self.db:
            self.db.execute("UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?",
                            (now + 0.25, message_id))

    def unconsumed(self):
        with self.lock:
            # Clock expiry never deletes accepted mail. Its consumer decides whether
            # to expose the contents or expiry metadata, then explicitly consumes it.
            return [(json.loads(row[0]), row[1]) for row in self.db.execute(
                "SELECT message,expires FROM inbox WHERE consumed=0 ORDER BY rowid")]

    def consume(self, ids):
        with self.lock, self.db:
            count = 0
            for message_id in set(ids):
                count += self.db.execute("UPDATE inbox SET consumed=1 WHERE id=? AND consumed=0", (message_id,)).rowcount
            return count

    def status(self):
        with self.lock:
            pending = self.db.execute("SELECT recipients,receipts FROM outbox WHERE status='pending'").fetchall()
            inbox = self.db.execute("SELECT COUNT(*) FROM inbox WHERE consumed=0").fetchone()[0]
            return {"pending": len(pending), "pendingRecipients": sum(
                len(json.loads(row[0])) - len(json.loads(row[1])) for row in pending), "inbox": inbox}

    def close(self):
        with self.lock:
            self.db.close()
