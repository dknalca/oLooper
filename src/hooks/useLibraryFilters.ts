import { useEffect, useState } from "react";

/** Persist library search and filter choices independently of catalog loading. */
export function useLibraryFilters() {
  const [search, setSearch] = useState(() => localStorage.getItem("olooper.library.search") ?? "");
  const [sourceFilter, setSourceFilter] = useState(() => localStorage.getItem("olooper.library.source") ?? "all");
  const [bpmFilter, setBpmFilter] = useState(() => localStorage.getItem("olooper.library.bpm") ?? "all");
  const [durationFilter, setDurationFilter] = useState(() => localStorage.getItem("olooper.library.duration") ?? "all");
  const hasFilters = search !== "" || sourceFilter !== "all" || bpmFilter !== "all" || durationFilter !== "all";
  const clearFilters = () => {
    setSearch("");
    setSourceFilter("all");
    setBpmFilter("all");
    setDurationFilter("all");
  };
  useEffect(() => { localStorage.setItem("olooper.library.search", search); }, [search]);
  useEffect(() => { localStorage.setItem("olooper.library.source", sourceFilter); }, [sourceFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.bpm", bpmFilter); }, [bpmFilter]);
  useEffect(() => { localStorage.setItem("olooper.library.duration", durationFilter); }, [durationFilter]);
  return { search, setSearch, sourceFilter, setSourceFilter, bpmFilter, setBpmFilter, durationFilter, setDurationFilter, hasFilters, clearFilters };
}
