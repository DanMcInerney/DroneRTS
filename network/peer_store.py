"""Bounded durable mail for one native peer.

Expiry values use the caller's monotonic host clock. SQLite pages and indexes count
against the radio allocation; a conservative 256 KiB within that allocation is
left for rollback journals (also reported as transaction staging). No WAL is used.
All mutations touch at most two bounded message rows per transaction. Expiration
and consumption use separate transactions per row, never an unbounded bulk delete.
"""

import hashlib
import json
import math
import os
import sqlite3
import threading
import time
from contextlib import contextmanager

RADIO_BYTES = 4 * 1024 * 1024
TRANSACTION_BYTES = 256 * 1024
DATABASE_BYTES = RADIO_BYTES - TRANSACTION_BYTES
CONTROL_BYTES = 64 * 1024
PAGE_BYTES = 4096
MAX_MESSAGE_BYTES = 16 * 1024
MAX_QUEUE = 256
CONTROL_QUEUE = 16
MAX_RECORDS = 2048
MAX_RETRY_SECONDS = 600


def encode(value):
    return json.dumps(value, separators=(",", ":"), sort_keys=True, allow_nan=False, ensure_ascii=False)


def digest(body):
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


def control(message):
    # Only the host-bound player identity can enter the reserved class.
    return message.get("from") == "player" and message.get("kind") == "mission"


class PeerStore:
    def __init__(self, path, drone, session):
        self.lock = threading.RLock()
        self.path = os.path.abspath(path)
        self.journal_peak = 0
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.row_factory = sqlite3.Row
        try:
            self.db.execute("PRAGMA journal_mode=DELETE")
            self.db.execute("PRAGMA synchronous=FULL")
            self.db.execute("PRAGMA page_size=4096")
            self.db.execute("PRAGMA auto_vacuum=INCREMENTAL")
            self.db.execute("PRAGMA secure_delete=OFF")
            self.db.execute("PRAGMA cache_spill=OFF")
            self.db.execute("PRAGMA cache_size=-256")
            self.db.execute("PRAGMA journal_size_limit=0")
            if self.db.execute("PRAGMA page_size").fetchone()[0] != PAGE_BYTES:
                raise ValueError("Radio store uses an unsupported SQLite page size")
            if self.db.execute("PRAGMA page_count").fetchone()[0] * PAGE_BYTES > DATABASE_BYTES:
                raise ValueError("radio storage-full: existing database exceeds bounded mail allocation")
            self.db.execute(f"PRAGMA max_page_count={DATABASE_BYTES // PAGE_BYTES}")
            self.db.executescript("""
                CREATE TABLE IF NOT EXISTS identity (drone TEXT, session TEXT);
                CREATE TABLE IF NOT EXISTS outbox (
                    id TEXT PRIMARY KEY, message TEXT NOT NULL, recipients TEXT NOT NULL,
                    receipts TEXT NOT NULL DEFAULT '[]', expires REAL NOT NULL,
                    next_attempt REAL NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
                    status TEXT NOT NULL DEFAULT 'pending', digest TEXT NOT NULL DEFAULT '',
                    kind TEXT NOT NULL DEFAULT 'radio', reserved INTEGER NOT NULL DEFAULT 0,
                    sender TEXT NOT NULL DEFAULT '',
                    status_head INTEGER NOT NULL DEFAULT 0, status_boot TEXT NOT NULL DEFAULT '',
                    status_sequence INTEGER NOT NULL DEFAULT 0, status_sent TEXT NOT NULL DEFAULT '',
                    status_to TEXT NOT NULL DEFAULT 'all', status_until REAL NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS inbox (
                    sender TEXT NOT NULL, id TEXT NOT NULL, message TEXT NOT NULL,
                    expires REAL NOT NULL DEFAULT 0, consumed INTEGER NOT NULL DEFAULT 0,
                    digest TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'radio',
                    reserved INTEGER NOT NULL DEFAULT 0, status_head INTEGER NOT NULL DEFAULT 0,
                    status_boot TEXT NOT NULL DEFAULT '', status_sequence INTEGER NOT NULL DEFAULT 0,
                    status_sent TEXT NOT NULL DEFAULT '', status_until REAL NOT NULL DEFAULT 0, PRIMARY KEY(sender, id)
                );
            """)
            owner = self.db.execute("SELECT * FROM identity").fetchone()
            if owner and (owner["drone"] != drone or owner["session"] != session):
                raise ValueError("Store belongs to another drone or fleet session")
            if not owner:
                with self._transaction():
                    self.db.execute("INSERT INTO identity VALUES (?, ?)", (drone, session))
            # Upgrade bounded development stores without discarding durable unread mail.
            additions = {
                "outbox": {"digest": "TEXT NOT NULL DEFAULT ''", "kind": "TEXT NOT NULL DEFAULT 'radio'",
                           "reserved": "INTEGER NOT NULL DEFAULT 0", "sender": "TEXT NOT NULL DEFAULT ''", "status_to": "TEXT NOT NULL DEFAULT 'all'"},
                "inbox": {"expires": "REAL NOT NULL DEFAULT 0", "digest": "TEXT NOT NULL DEFAULT ''",
                          "kind": "TEXT NOT NULL DEFAULT 'radio'", "reserved": "INTEGER NOT NULL DEFAULT 0"},
            }
            for columns in additions.values():
                columns.update({"status_head": "INTEGER NOT NULL DEFAULT 0", "status_boot": "TEXT NOT NULL DEFAULT ''",
                                "status_sequence": "INTEGER NOT NULL DEFAULT 0", "status_sent": "TEXT NOT NULL DEFAULT ''",
                                "status_until": "REAL NOT NULL DEFAULT 0"})
            for table, columns in additions.items():
                present = {row["name"] for row in self.db.execute(f"PRAGMA table_info({table})")}
                for name, declaration in columns.items():
                    if name not in present:
                        with self._transaction():
                            self.db.execute(f"ALTER TABLE {table} ADD COLUMN {name} {declaration}")
                for row in self.db.execute(f"SELECT rowid,message FROM {table} WHERE digest='' AND message<>''").fetchall():
                    message = json.loads(row["message"])
                    with self._transaction():
                        self.db.execute(f"UPDATE {table} SET digest=?,kind=?,reserved=? WHERE rowid=?",
                                        (digest(row["message"]), message.get("kind", "radio"), int(control(message)), row["rowid"]))
                        if table == "outbox":
                            self.db.execute("UPDATE outbox SET sender=? WHERE rowid=?", (message.get("from", ""), row["rowid"]))
            self._check_disk()
        except Exception:
            self.db.close()
            raise

    def _disk(self):
        def size(path):
            try:
                return os.path.getsize(path)
            except FileNotFoundError:
                return 0
        database = size(self.path)
        staging = sum(size(self.path + suffix) for suffix in ("-journal", "-wal", "-shm"))
        return database, staging

    def _check_disk(self):
        database, staging = self._disk()
        self.journal_peak = max(self.journal_peak, staging)
        if staging > TRANSACTION_BYTES or database + staging > RADIO_BYTES:
            raise ValueError("radio storage-full: bounded transaction allocation exhausted")

    @contextmanager
    def _transaction(self):
        try:
            self.db.execute("BEGIN IMMEDIATE")
            with self.db:
                yield
                self._check_disk()
        except sqlite3.OperationalError as error:
            if getattr(error, "sqlite_errorcode", None) == sqlite3.SQLITE_FULL or "full" in str(error).lower():
                raise ValueError("radio storage-full: SQLite page allocation exhausted") from error
            raise

    def _message(self, message, expires):
        body = encode(message)
        if len(body.encode("utf-8")) > MAX_MESSAGE_BYTES:
            raise ValueError("radio storage-full: message exceeds the 16 KiB store record limit")
        for name, limit in (("id", 200), ("from", 64)):
            if not isinstance(message.get(name), str) or not 1 <= len(message[name].encode("utf-8")) <= limit:
                raise ValueError(f"Invalid stored message {name}")
        if not isinstance(expires, (int, float)) or not math.isfinite(expires):
            raise ValueError("Invalid stored message deadline")
        return body, digest(body)

    def _admit(self, message, body, recipients="[]"):
        reserved = control(message)
        count = self.db.execute("SELECT (SELECT COUNT(*) FROM inbox)+(SELECT COUNT(*) FROM outbox)").fetchone()[0]
        if count >= MAX_RECORDS + (CONTROL_QUEUE if reserved else 0):
            raise ValueError("radio storage-full: deduplication record limit; wait for expiry")
        active = self.db.execute("SELECT (SELECT COUNT(*) FROM inbox WHERE consumed=0) + "
                                 "(SELECT COUNT(*) FROM outbox WHERE status='pending')").fetchone()[0]
        if active >= MAX_QUEUE + (CONTROL_QUEUE if reserved else 0):
            raise ValueError("radio storage-full: durable queue limit; consume mail or wait for expiry")
        pages = self.db.execute("PRAGMA page_count").fetchone()[0]
        free = self.db.execute("PRAGMA freelist_count").fetchone()[0]
        # Account for actual live pages, B-tree splits, row/index metadata and the
        # next bounded payload. Conservative headroom is intentional, not credit
        # for a payload estimate masquerading as a filesystem quota.
        growth = math.ceil((len(body.encode("utf-8")) + len(recipients.encode("utf-8")) + 2048) / PAGE_BYTES) + 8
        limit = DATABASE_BYTES - (0 if reserved else CONTROL_BYTES)
        if (pages - free + growth) * PAGE_BYTES > limit:
            raise ValueError("radio storage-full: mail allocation reserved for objective/control traffic")

    def _status_fields(self, message):
        # Legacy column names retain native sender identity; text labels no longer coalesce.
        return (0, str(message.get("bootId", "")),
                int(message.get("senderSequence", message.get("sequence", 0))), str(message.get("sentAt", "")))

    def sender_binding(self, message_id):
        """Existing immutable native identity, including payload-cleared tombstones."""
        with self.lock:
            row = self.db.execute("SELECT status_boot,status_sequence FROM outbox WHERE id=?", (message_id,)).fetchone()
            return {"bootId": row["status_boot"], "senderSequence": row["status_sequence"]} if row else None

    @staticmethod
    def _deadline(message, expires):
        now = time.monotonic()
        if expires <= now:
            raise ValueError("Message deadline already expired")
        return min(expires, now + MAX_RETRY_SECONDS)

    def queue(self, message, recipients, expires):
        body, checksum = self._message(message, expires)
        expires = self._deadline(message, expires)
        if not isinstance(recipients, list) or not 1 <= len(recipients) <= 4 or len(set(recipients)) != len(recipients) or any(
                not isinstance(value, str) or len(value.encode("utf-8")) > 64 for value in recipients):
            raise ValueError("Invalid bounded recipients")
        encoded_recipients = encode(recipients)
        with self.lock:
            existing = self.db.execute("SELECT digest,recipients FROM outbox WHERE id=?", (message["id"],)).fetchone()
            if existing:
                if existing["digest"] != checksum or existing["recipients"] != encoded_recipients:
                    raise ValueError("Message ID already exists with different contents")
                return
            self._admit(message, body, encoded_recipients)
            with self._transaction():
                self.db.execute("INSERT INTO outbox(id,message,recipients,expires,digest,kind,reserved,sender,status_head,status_boot,status_sequence,status_sent,status_to,status_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                                (message["id"], body, encoded_recipients, expires, checksum, message.get("kind", "radio"), int(control(message)), message["from"], *self._status_fields(message), message.get("to", "all"), 0))

    def accept(self, message, expires):
        body, checksum = self._message(message, expires)
        expires = self._deadline(message, expires)
        with self.lock:
            existing = self.db.execute("SELECT digest FROM inbox WHERE sender=? AND id=?", (message["from"], message["id"])).fetchone()
            if existing:
                if existing["digest"] != checksum:
                    raise ValueError("Conflicting duplicate message")
                return False
            self._admit(message, body)
            with self._transaction():
                self.db.execute("INSERT INTO inbox(sender,id,message,expires,digest,kind,reserved,status_head,status_boot,status_sequence,status_sent,status_until) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
                                (message["from"], message["id"], body, expires, checksum, message.get("kind", "radio"), int(control(message)), *self._status_fields(message), 0))
            return True

    def acknowledge(self, message_id, recipient, now):
        with self.lock:
            row = self.db.execute("SELECT * FROM outbox WHERE id=? AND status='pending'", (message_id,)).fetchone()
            if not row or row["expires"] <= now:
                return None
            recipients, receipts = json.loads(row["recipients"]), json.loads(row["receipts"])
            if recipient not in recipients or recipient in receipts:
                return None
            receipts.append(recipient)
            complete = set(receipts) == set(recipients)
            with self._transaction():
                self.db.execute("UPDATE outbox SET receipts=?,status=?,message=? WHERE id=?",
                                (encode(sorted(receipts)), "received" if complete else "pending", "" if complete else row["message"], message_id))
            return recipients if complete else None

    def expire(self, now):
        with self.lock:
            expired = []
            for row in self.db.execute("SELECT rowid,* FROM outbox WHERE expires<=?", (now,)).fetchall():
                if row["status"] == "pending":
                    expired.append({"id": row["id"], "recipients": row["recipients"], "receipts": row["receipts"]})
                with self._transaction():
                    self.db.execute("DELETE FROM outbox WHERE rowid=?", (row["rowid"],))
            # Retry deadlines concern delivery, not the lifetime of received text.
            # Unread radio consumes bounded storage until explicit consumption.
            with self._transaction():
                self.db.execute("DELETE FROM inbox WHERE expires<=? AND consumed=1", (now,))
            # Incremental single-page reclamation avoids unbounded VACUUM scratch
            # files/transactions. Free pages remain reusable even before trimming.
            for _ in range(min(8, self.db.execute("PRAGMA freelist_count").fetchone()[0])):
                with self._transaction():
                    self.db.execute("PRAGMA incremental_vacuum(1)")
            return expired

    def due(self, now):
        with self.lock:
            return [dict(row) for row in self.db.execute(
                "SELECT * FROM outbox WHERE status='pending' AND expires>? AND next_attempt<=? "
                "ORDER BY reserved DESC,CASE kind WHEN 'transfer' THEN 1 ELSE 0 END,rowid LIMIT 16", (now, now))]

    def attempted(self, message_id, now):
        with self.lock, self._transaction():
            row = self.db.execute("SELECT attempts FROM outbox WHERE id=? AND status='pending'", (message_id,)).fetchone()
            if row:
                self.db.execute("UPDATE outbox SET attempts=attempts+1,next_attempt=? WHERE id=?",
                                (now + min(4.0, 0.25 * 2 ** min(row["attempts"], 4)), message_id))

    def unconsumed(self):
        with self.lock:
            return [(json.loads(row[0]), row[1]) for row in self.db.execute(
                "SELECT message,expires FROM inbox WHERE consumed=0 ORDER BY rowid")]

    def consume(self, ids):
        with self.lock:
            count = 0
            for message_id in set(ids):
                for row in self.db.execute("SELECT rowid,kind FROM inbox WHERE id=? AND consumed=0", (message_id,)).fetchall():
                    with self._transaction():
                        self.db.execute("UPDATE inbox SET consumed=1,message='' WHERE rowid=?", (row["rowid"],))
                    count += 1
            return count

    def status(self):
        with self.lock:
            pending = self.db.execute("SELECT recipients,receipts FROM outbox WHERE status='pending'").fetchall()
            inbox = self.db.execute("SELECT COUNT(*) FROM inbox WHERE consumed=0").fetchone()[0]
            records = self.db.execute("SELECT (SELECT COUNT(*) FROM inbox)+(SELECT COUNT(*) FROM outbox)").fetchone()[0]
            database, staging = self._disk()
            free = self.db.execute("PRAGMA freelist_count").fetchone()[0] * PAGE_BYTES
            return {"pending": len(pending), "pendingRecipients": sum(len(json.loads(row[0])) - len(json.loads(row[1])) for row in pending),
                    "inbox": inbox, "storageBytes": database + staging, "storageLimitBytes": RADIO_BYTES,
                    "storageRemainingBytes": max(0, RADIO_BYTES - database - staging), "stagingBytes": staging,
                    "transactionReserveBytes": TRANSACTION_BYTES, "journalPeakBytes": self.journal_peak,
                    "controlReservedBytes": CONTROL_BYTES, "queueLimit": MAX_QUEUE, "records": records,
                    "tombstones": records - len(pending) - inbox, "reusableBytes": free}

    def close(self):
        with self.lock:
            self.db.close()
