import {
  onSnapshot,
  doc,
  getDoc,
  setDoc,
  getDocs,
  collection,
  query,
  limit,
  type Query,
  type DocumentData,
  type DocumentReference
} from "firebase/firestore";
import {
  FirestoreState,
  type FirestoreStateOptions,
  type PathParam,
  type QueryParamsFn
} from "./FirestoreState.svelte.js";

type DocumentStateOptions<
  DataDb extends DocumentData,
  DataApp extends DocumentData
> = Omit<FirestoreStateOptions<DataDb, DataApp>, "pathFunctionOrString"> &
  (
    | {
        path?: never;
        collectionPath?: PathParam;
        query?: QueryParamsFn;
      }
    | {
        path?: PathParam;
        collectionPath?: never;
        query?: never;
      }
  );

export class DocumentState<
  DataDb extends DocumentData,
  DataApp extends DataDb & { id: string } = DataDb & { id: string }
> extends FirestoreState<DataDb, DataApp, DataApp> {
  private readonly collectionPathFunctionOrString?: PathParam;
  private readonly queryParams?: QueryParamsFn;

  private docRef: DocumentReference | undefined | null;
  private queryRef: Query | undefined;

  constructor({
    auth,
    firestore,
    path: pathFunctionOrString,
    collectionPath: collectionPathFunctionOrString,
    query: queryParams,
    listen = false,
    fromFirestore,
    toFirestore
  }: DocumentStateOptions<DataDb, DataApp>) {
    super({
      auth,
      firestore,
      listen,
      fromFirestore,
      toFirestore,
      pathFunctionOrString: pathFunctionOrString ?? undefined
    });

    this.collectionPathFunctionOrString = collectionPathFunctionOrString;
    this.queryParams = queryParams;
  }

  private async get_doc_ref(): Promise<typeof this.docRef | undefined> {
    if (this.docRef) {
      return this.docRef;
    }

    const user = await this.getUser;

    if (this.pathFunctionOrString) {
      let pathStr = await this.get_path_string();

      if (!pathStr) {
        this.docRef = null;
        return this.docRef;
      }

      const pathArray: [string, ...string[]] = pathStr.split("/") as [
        string,
        ...string[]
      ];

      this.docRef = doc(this.firestore, ...pathArray).withConverter(
        this.converter
      );
    } else if (this.collectionPathFunctionOrString) {
      // Run query and get first document ref

      let collectionPath: string | null | undefined;
      if (typeof this.collectionPathFunctionOrString === "function") {
        collectionPath = this.collectionPathFunctionOrString(user);
      } else {
        collectionPath = this.collectionPathFunctionOrString;
      }

      if (!collectionPath || !this.queryParams) {
        throw new Error(
          `"collectionPath" and "query" options must be defined.`
        );
      }

      const queryRef = query(
        collection(this.firestore, collectionPath),
        ...this.queryParams(user),
        limit(1)
      );

      if (!queryRef) {
        this.docRef = undefined;
        return this.docRef;
      }

      this.queryRef = queryRef;
      const querySnapshot = await getDocs(queryRef);
      this.docRef = querySnapshot.docs[0]?.ref.withConverter(this.converter);
    }

    return this.docRef;
  }

  protected async fetch_data(): Promise<void> {
    this.loading = true;

    await this.get_doc_ref();

    if (!this.docRef) {
      this.value = null;
      return;
    }

    const docSnap = await getDoc(this.docRef);

    if (!docSnap.exists()) {
      this.value = null;
    } else {
      this.value = docSnap.data() as DataApp;
    }

    this.loading = false;
  }

  protected async listen(): Promise<void> {
    if (this.unsub) {
      return;
    }

    await this.get_doc_ref();

    if (!this.docRef) {
      // If there is no docRef, we can still try to listen to the queryRef
      this.listen_to_query();
      return;
    }

    this.listen_to_doc();
  }

  private listen_to_query() {
    if (!this.queryRef) {
      return;
    }

    this.unsub?.();
    this.unsub = onSnapshot(this.queryRef, (querySnapshot) => {
      if (!querySnapshot.empty) {
        // We found a document
        const docSnap = querySnapshot.docs[0];
        this.docRef = docSnap.ref;
        this.unsub?.();
        this.listen_to_doc();
      } else {
        this.value = null;
      }
    });

    return this.unsub;
  }

  private listen_to_doc() {
    if (!this.docRef) {
      return;
    }

    this.unsub?.();
    this.unsub = onSnapshot(this.docRef, (docSnap) => {
      if (!docSnap.exists()) {
        this.value = null;
        // If the document doesn't exist
        // We can still try to listen to the queryRef
        this.listen_to_query();
        return;
      }
      const newData = docSnap.data() as DataApp;

      // TODO: Check if the data we receive is the same as the one we have
      // in this case we don't need to update the value
      this.value = newData;
    });

    return this.unsub;
  }

  private save_data_to_firebase() {
    if (!this.docRef) {
      return;
    }
    return setDoc(this.docRef, this.value || null, { merge: true });
  }

  public save<K extends keyof DataApp>(
    key?: K,
    update?: DataApp[K] | ((prevValue: DataApp[K]) => DataApp[K])
  ): void {
    if (!key) {
      this.save_data_to_firebase();
      return;
    }

    if (!update || !this.docRef || !this.value) {
      return;
    }

    let newValue: DataApp[K];
    if (typeof update === "function") {
      const updateFn = update as (prevValue: DataApp[K]) => DataApp[K];
      const prevValue = this.value[key];
      newValue = updateFn(prevValue);
    } else {
      newValue = update;
    }

    this.value[key] = newValue as NonNullable<DataApp>[K];

    this.save_data_to_firebase();
  }
}
