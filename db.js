/* =========================================================================
   db.js  —  데이터 계층 (Data Layer)
   -------------------------------------------------------------------------
   화면 코드는 이 파일의 db.* 함수만 호출합니다.
   백엔드(데모 / Firebase)를 여기서 한 번에 갈아끼웁니다.

   ▶ 처음엔 DEMO_MODE = true 로 그냥 테스트하세요.
     (같은 브라우저 안에서 학부모 탭 ↔ 관리자 탭이 연동됩니다)

   ▶ 실제로 여러 기기에서 쓰려면:
     1) Firebase 프로젝트 만들고 firebaseConfig 채우기 (README 참고)
     2) 아래 DEMO_MODE 를 false 로 변경
   ========================================================================= */

const DEMO_MODE = true;

// ↓↓↓ 실서비스 전환 시 Firebase 콘솔에서 복사한 값으로 채우세요 ↓↓↓
const firebaseConfig = {
  apiKey: "여기에-붙여넣기",
  authDomain: "여기에-붙여넣기",
  projectId: "여기에-붙여넣기",
  storageBucket: "여기에-붙여넣기",
  messagingSenderId: "여기에-붙여넣기",
  appId: "여기에-붙여넣기",
};

// 관리자 비밀번호 (데모용). 실서비스에서는 Firebase 보안 규칙으로 보호하세요.
const ADMIN_PASSWORD = "school1234";

/* 결석 데이터의 고유 키 = 날짜__학생ID
   → 담임이든 학부모든 같은 학생/같은 날이면 같은 칸에 저장됨 → 자동 1회 처리 */
function absenceKey(date, studentId) {
  return `${date}__${studentId}`;
}

/* =========================================================================
   1) 데모 백엔드  (브라우저 localStorage)
   ========================================================================= */
const DemoDB = {
  _read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
    catch { return fallback; }
  },
  _write(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
    // 같은 탭에서도 구독 콜백이 돌도록 수동 신호
    window.dispatchEvent(new Event("demodb-change"));
  },

  _seed() {
    if (!localStorage.getItem("roster")) {
      this._write("roster", [
        { id: "s1", name: "김민준", klass: "1학년 1반" },
        { id: "s2", name: "이서연", klass: "1학년 2반" },
        { id: "s3", name: "박지호", klass: "2학년 1반" },
        { id: "s4", name: "최하은", klass: "2학년 3반" },
        { id: "s5", name: "정우진", klass: "3학년 2반" },
      ]);
    }
  },

  async getRoster() {
    this._seed();
    return this._read("roster", []);
  },

  async addStudent(name, klass) {
    const roster = await this.getRoster();
    const id = "s" + Date.now();
    roster.push({ id, name, klass });
    this._write("roster", roster);
    return { id, name, klass };
  },

  async removeStudent(id) {
    const roster = (await this.getRoster()).filter((s) => s.id !== id);
    this._write("roster", roster);
  },

  // 엑셀/CSV 일괄 추가. list: [{name, klass}, ...] → 추가된 학생 배열 반환
  async addStudentsBulk(list) {
    const roster = await this.getRoster();
    const added = list.map((s, i) => ({
      id: "s" + Date.now() + "_" + i,
      name: s.name,
      klass: s.klass,
    }));
    this._write("roster", roster.concat(added));
    return added;
  },

  // 결석 보고 (date: 'YYYY-MM-DD', by: 'parent' | 'teacher')
  async reportAbsence(date, student, by) {
    const all = this._read("absences", {});
    all[absenceKey(date, student.id)] = {
      date,
      studentId: student.id,
      studentName: student.name,
      klass: student.klass,
      reportedBy: by,          // 마지막 입력자 기록
      ts: Date.now(),
    };
    this._write("absences", all);
  },

  async cancelAbsence(date, studentId) {
    const all = this._read("absences", {});
    delete all[absenceKey(date, studentId)];
    this._write("absences", all);
  },

  async getAbsences(date) {
    const all = this._read("absences", {});
    return Object.values(all).filter((a) => a.date === date);
  },

  // 특정 날짜 결석 목록 실시간 구독
  subscribeAbsences(date, cb) {
    const fire = async () => cb(await this.getAbsences(date));
    fire();
    const onChange = () => fire();
    window.addEventListener("storage", onChange);          // 다른 탭 변경
    window.addEventListener("demodb-change", onChange);     // 같은 탭 변경
    return () => {
      window.removeEventListener("storage", onChange);
      window.removeEventListener("demodb-change", onChange);
    };
  },
};

/* =========================================================================
   2) Firebase 백엔드  (실서비스)
   ========================================================================= */
const FirebaseDB = {
  _ready: null,
  _fs: null,   // firestore 인스턴스
  _api: null,  // firestore 함수 모음

  async _init() {
    if (this._ready) return this._ready;
    this._ready = (async () => {
      const appMod = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js"
      );
      const fsMod = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const app = appMod.initializeApp(firebaseConfig);
      this._fs = fsMod.getFirestore(app);
      this._api = fsMod;
    })();
    return this._ready;
  },

  async getRoster() {
    await this._init();
    const { collection, getDocs } = this._api;
    const snap = await getDocs(collection(this._fs, "students"));
    return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  },

  async addStudent(name, klass) {
    await this._init();
    const { collection, addDoc } = this._api;
    const ref = await addDoc(collection(this._fs, "students"), { name, klass });
    return { id: ref.id, name, klass };
  },

  async removeStudent(id) {
    await this._init();
    const { doc, deleteDoc } = this._api;
    await deleteDoc(doc(this._fs, "students", id));
  },

  // 엑셀/CSV 일괄 추가 (배치 쓰기, 한 번에 최대 500건씩 나눠 처리)
  async addStudentsBulk(list) {
    await this._init();
    const { collection, doc, writeBatch } = this._api;
    const added = [];
    for (let i = 0; i < list.length; i += 450) {
      const chunk = list.slice(i, i + 450);
      const batch = writeBatch(this._fs);
      chunk.forEach((s) => {
        const ref = doc(collection(this._fs, "students"));
        batch.set(ref, { name: s.name, klass: s.klass });
        added.push({ id: ref.id, name: s.name, klass: s.klass });
      });
      await batch.commit();
    }
    return added;
  },

  async reportAbsence(date, student, by) {
    await this._init();
    const { doc, setDoc } = this._api;
    // 문서 ID = 날짜__학생ID → 이중입력이 같은 문서에 덮어써짐 (자동 1회)
    await setDoc(doc(this._fs, "absences", absenceKey(date, student.id)), {
      date,
      studentId: student.id,
      studentName: student.name,
      klass: student.klass,
      reportedBy: by,
      ts: Date.now(),
    });
  },

  async cancelAbsence(date, studentId) {
    await this._init();
    const { doc, deleteDoc } = this._api;
    await deleteDoc(doc(this._fs, "absences", absenceKey(date, studentId)));
  },

  async getAbsences(date) {
    await this._init();
    const { collection, query, where, getDocs } = this._api;
    const q = query(collection(this._fs, "absences"), where("date", "==", date));
    const snap = await getDocs(q);
    return snap.docs.map((d) => d.data());
  },

  subscribeAbsences(date, cb) {
    let unsub = () => {};
    (async () => {
      await this._init();
      const { collection, query, where, onSnapshot } = this._api;
      const q = query(collection(this._fs, "absences"), where("date", "==", date));
      unsub = onSnapshot(q, (snap) => cb(snap.docs.map((d) => d.data())));
    })();
    return () => unsub();
  },
};

/* 화면 코드가 사용하는 단일 진입점 */
const db = DEMO_MODE ? DemoDB : FirebaseDB;
