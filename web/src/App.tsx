import { Navigate, Route, Routes } from "react-router-dom";
import Header from "./components/Header";
import { RunsListProvider } from "./hooks/useRunsList";
import Run from "./routes/Run";
import Runs from "./routes/Runs";

/**
 * The shell: the header and two screens, the runs list and one run. `/` and any unknown path
 * land on the list. Shape cited from qodo-cli web/src/App.tsx @
 * ee73d5682a02952a76567887995b4f2e3aca5ea2 (which cited culture-rules web/src/App.tsx).
 */
export function App() {
  return (
    <RunsListProvider>
      <div className="app">
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app__frame">
          <Header />
          <main id="main" className="page" tabIndex={-1}>
            <Routes>
              <Route path="/runs" element={<Runs />} />
              <Route path="/runs/:runId" element={<Run />} />
              <Route path="*" element={<Navigate to="/runs" replace />} />
            </Routes>
          </main>
        </div>
      </div>
    </RunsListProvider>
  );
}

export default App;
