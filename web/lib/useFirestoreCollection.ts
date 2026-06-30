/**
 * Back-compat re-export.
 *
 * The hook moved to useRealtimeCollection.ts when Pocketbase support
 * landed — the new file's `useRealtimeCollection` is backend-aware
 * (Firestore onSnapshot OR Pocketbase SSE depending on env). Existing
 * imports of `useFirestoreCollection` keep working through this alias.
 */
export {
  useRealtimeCollection,
  useFirestoreCollection,
} from "./useRealtimeCollection";
