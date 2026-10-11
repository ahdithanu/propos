import { PgStore } from "@/adapters/postgres/store";
import { storeContract } from "../contract/store-contract";
import { SEED, inRolledBackTx } from "./helpers";

// Each test runs inside one transaction that is rolled back, so the database is left as seeded.
storeContract("Postgres", (fn) => inRolledBackTx((db) => fn({ store: new PgStore(db), ...SEED })));
