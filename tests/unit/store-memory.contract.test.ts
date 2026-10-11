import { CONTACTS, OWNER, PROPERTY_ID, createTestStore } from "@/harness/testing";
import { storeContract } from "../contract/store-contract";

storeContract("in-memory", (fn) =>
  fn({
    store: createTestStore(),
    ownerContactId: OWNER.contactId, ownerPhone: OWNER.phone,
    tenantContactId: CONTACTS.tenant.id, tenantPhone: CONTACTS.tenant.phone, tenantEmail: CONTACTS.tenant.email,
    tenantId: "t-maria", propertyId: PROPERTY_ID, plumberVendorId: "v-plumber",
  }),
);
