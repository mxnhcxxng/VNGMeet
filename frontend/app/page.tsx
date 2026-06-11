"use client";

import { useCallback, useEffect, useState } from "react";
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  Chip,
  Select,
  SelectItem,
  Spinner,
  Textarea,
} from "@heroui/react";
import { api, type Me, type ScheduleResponse } from "@/lib/api";
import { RoomGrid } from "@/components/RoomGrid";

const DAY_OPTIONS = [
  { key: "3", label: "3 ngày" },
  { key: "5", label: "5 ngày" },
  { key: "7", label: "7 ngày" },
  { key: "14", label: "14 ngày" },
];

function Legend() {
  return (
    <div className="flex items-center gap-4 text-xs text-default-500">
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-small bg-success-400" /> Trống
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-small bg-warning-400" /> Tạm giữ
      </span>
      <span className="flex items-center gap-1">
        <span className="inline-block h-3 w-3 rounded-small bg-danger-400" /> Đã book
      </span>
    </div>
  );
}

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
          <p className="text-sm text-default-500">
            Đăng nhập để xem tình trạng phòng họp.
          </p>
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
              description="Lấy từ Graph Explorer (developer.microsoft.com/graph/graph-explorer) → tab Access token. Hết hạn ~1h thì dán lại."
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
  const [data, setData] = useState<ScheduleResponse | null>(null);
  const [days, setDays] = useState("7");
  const [selectedEmail, setSelectedEmail] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    api
      .me()
      .then(setMe)
      .catch(() => setMe({ authenticated: false }))
      .finally(() => setLoading(false));
  }, []);

  const loadSchedule = useCallback(async (d: string) => {
    setRefreshing(true);
    setError(null);
    try {
      const res = await api.schedule(parseInt(d, 10));
      setData(res);
      setSelectedEmail((prev) =>
        prev && res.rooms.some((r) => r.email === prev)
          ? prev
          : res.rooms[0]?.email ?? null
      );
    } catch (e: any) {
      setError(e.message === "UNAUTHENTICATED" ? "Phiên đăng nhập hết hạn." : e.message);
      if (e.message === "UNAUTHENTICATED") setMe({ authenticated: false });
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    if (me?.authenticated) loadSchedule(days);
  }, [me?.authenticated, days, loadSchedule]);

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

  const selectedRoom = data?.rooms.find((r) => r.email === selectedEmail) ?? null;

  return (
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">VNG Meet — Phòng họp</h1>
          <p className="text-sm text-default-500">
            {data?.timezone} · slot {data?.slotMinutes ?? "—"} phút
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Chip variant="flat" color="primary">
            {me.username}
          </Chip>
          <Button
            size="sm"
            variant="flat"
            onPress={() => api.logout().then(() => setMe({ authenticated: false }))}
          >
            Đăng xuất
          </Button>
        </div>
      </header>

      <Card className="mb-4">
        <CardBody className="flex flex-row flex-wrap items-center gap-3">
          <Select
            label="Phòng họp"
            selectedKeys={selectedEmail ? [selectedEmail] : []}
            className="max-w-xs"
            size="sm"
            onChange={(e) => setSelectedEmail(e.target.value)}
          >
            {(data?.rooms ?? []).map((r) => (
              <SelectItem key={r.email} textValue={r.name}>
                {r.name}
                {r.capacity ? ` · ${r.capacity} chỗ` : ""}
              </SelectItem>
            ))}
          </Select>
          <Select
            label="Số ngày"
            selectedKeys={[days]}
            className="max-w-[140px]"
            size="sm"
            onChange={(e) => e.target.value && setDays(e.target.value)}
          >
            {DAY_OPTIONS.map((o) => (
              <SelectItem key={o.key}>{o.label}</SelectItem>
            ))}
          </Select>
          <Button size="sm" variant="flat" onPress={() => loadSchedule(days)} isLoading={refreshing}>
            Làm mới
          </Button>
          <div className="ml-auto">
            <Legend />
          </div>
        </CardBody>
      </Card>

      {error && (
        <Card className="mb-4 border border-danger-200">
          <CardBody className="text-sm text-danger">{error}</CardBody>
        </Card>
      )}

      {refreshing && !data ? (
        <div className="flex justify-center py-10">
          <Spinner label="Đang quét phòng họp..." />
        </div>
      ) : !data?.rooms.length ? (
        <Card>
          <CardBody className="text-center text-default-500">
            Không tìm thấy phòng nào được đánh dấu là meeting room.
          </CardBody>
        </Card>
      ) : selectedRoom ? (
        <RoomGrid room={selectedRoom} days={data.days} times={data.times} />
      ) : null}
    </main>
  );
}
