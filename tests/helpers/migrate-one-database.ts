/**
 * Opens one database through the production constructor and exits, so a test can put a real
 * second process into a migration race (#747).
 *
 * Deliberately not a stub that writes a version: it takes the same lock, validates the same
 * approval and runs the same ordered chain that every other opener does, because the property
 * under test is what happens to a *later* process when a real migration has already committed.
 */
import { openDb } from "../../src/db/database.ts";

const databasePath = process.argv[2];
if (!databasePath) throw new Error("a database path is required");

openDb(databasePath).close();
process.stdout.write("migrated\n");
