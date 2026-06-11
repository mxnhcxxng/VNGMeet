"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Spinner,
  Textarea,
} from "@heroui/react";
import { api, type Me, type ScheduleResponse } from "@/lib/api";
import { Sidebar, type View } from "@/components/Sidebar";
import { BrowseRooms } from "@/components/BrowseRooms";
import { ChatPanel } from "@/components/ChatPanel";

const RANGE_DAYS = 14;

function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitToken = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.setToken(token.trim());
      onAuthed();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-lg">
        <CardHeader className="flex-col items-start gap-1">
          <h1 className="text-xl font-semibold">VNG Meet</h1>
          <p className="text-sm text-default-500">Đăng nhập để xem tình trạng phòng họp.</p>
        </CardHeader>
        <CardBody className="gap-5">
          <Button color="primary" as="a" href={api.loginUrl()}>
            Đăng nhập với Microsoft
          </Button>

          <div className="flex items-center gap-3 text-xs text-default-400">
            <div className="h-px flex-1 bg-default-200" />
            HOẶC TEST NHANH
            <div className="h-px flex-1 bg-default-200" />
          </div>

          <div className="flex flex-col gap-2">
            <Textarea
              label="Graph access token"
              description="Lấy từ Graph Explorer → tab Access token. Hết hạn ~1h thì dán lại."
              placeholder="eyJ0eXAiOiJKV1QiLCJ..."
              minRows={3}
              value={token}
              onValueChange={setToken}
            />
            <Button
              variant="flat"
              color="secondary"
              isDisabled={!token.trim()}
              isLoading={busy}
              onPress={submitToken}
            >
              Dùng access token này
            </Button>
            {err && <p className="text-xs text-danger">{err}</p>}
          </div>
        </CardBody>
      </Card>
    </div>
  );
}

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>("browse");
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [dayIndex, setDayIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authenticated: false }))
      .finally(() => setLoading(false));
  }, []);

  const loadSchedule = useCallback(async () => {
    setRefreshing(true);
    setError(null);
    try {
      setData(await api.schedule(RANGE_DAYS));
    } catch (e: any) {
      setError(e.message === "UNAUTHENTICATED" ? "Phiên đăng nhập hết hạn." : e.message);
      if (e.message === "UNAUTHENTICATED") setMe({ authenticated: false });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (me?.authenticated) loadSchedule();
  }, [me?.authenticated, loadSchedule]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Spinner label="Đang tải..." />
      </div>
    );
  }

  if (!me?.authenticated) {
    return <LoginScreen onAuthed={() => api.me().then(setMe)} />;
  }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        view={view}
        onChange={setView}
        username={me.username}
        onLogout={() => api.logout().then(() => setMe({ authenticated: false }))}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-default-200 px-6 py-3">
          <h1 className="text-xl font-semibold">
            {view === "browse" ? "Phòng họp" : "Trợ lý phòng họp"}
          </h1>
          <span className="text-xs text-default-400">
            {data ? `${data.rooms.length} phòng · ${data.timezone}` : ""}
          </span>
        </header>

        {error && (
          <div className="border-b border-danger-200 bg-danger-50 px-6 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        <div className="min-h-0 flex-1">
          {refreshing && !data ? (
            <div className="flex h-full items-center justify-center">
              <Spinner label="Đang quét phòng họp..." />
            </div>
          ) : view === "chat" ? (
            <ChatPanel data={data} dayIndex={dayIndex} />
          ) : !data?.rooms.length ? (
            <div className="flex h-full items-center justify-center text-default-500">
              Không tìm thấy phòng nào được đánh dấu là meeting room.
            </div>
          ) : (
            <BrowseRooms
              data={data}
              dayIndex={dayIndex}
              setDayIndex={(fn) => setDayIndex((n) => fn(n))}
              refreshing={refreshing}
              onRefresh={loadSchedule}
            />
          )}
        </div>
      </main>
    </div>
  );
}
