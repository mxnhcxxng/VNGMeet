"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Chip,
  EmptyState,
  ListBox,
  ListBoxItem,
  Select,
  Spinner,
  toast,
} from "@heroui/react";
import { ArrowsRotateRight, TrashBin } from "@gravity-ui/icons";
import {
  api,
  type RoomScout as RoomScoutRow,
  type UserProfileOption,
} from "@/lib/api";

const DURATION_OPTIONS = [
  { value: "30", label: "30 min" },
  { value: "60", label: "1 hour" },
  { value: "90", label: "1.5 hours" },
  { value: "120", label: "2 hours" },
  { value: "180", label: "3 hours" },
];

function formatDateTime(value?: string | null) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    day: "2-digit",
    month: "2-digit",
  }).format(date);
}

function statusColor(status: RoomScoutRow["status"]) {
  if (status === "active") return "success";
  if (status === "failed") return "danger";
  return "default";
}

export function RoomScout({
  userOffice,
  officeOptions = [],
}: {
  userOffice?: string;
  officeOptions?: UserProfileOption[];
}) {
  const [scouts, setScouts] = useState<RoomScoutRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [duration, setDuration] = useState("60");
  const [capacity, setCapacity] = useState("4");
  const [office, setOffice] = useState(userOffice || "");

  useEffect(() => {
    setOffice(userOffice || "");
  }, [userOffice]);

  const activeScout = useMemo(
    () => scouts.find((scout) => scout.status === "active"),
    [scouts],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.roomScouts();
      setScouts(res.scouts);
    } catch (e: any) {
      toast.danger("Could not load Room Scout", {
        description: e.message === "UNAUTHENTICATED" ? "Please sign in again." : e.message,
      });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const createScout = async () => {
    const minCapacity = Number(capacity);
    const durationMinutes = Number(duration);
    if (!Number.isFinite(minCapacity) || minCapacity < 1) {
      toast.warning("Capacity must be at least 1.");
      return;
    }
    setSaving(true);
    try {
      await api.createRoomScout({
        duration_minutes: durationMinutes,
        min_capacity: Math.round(minCapacity),
        office: office || null,
      });
      toast.success("Room Scout started");
      await load();
    } catch (e: any) {
      toast.danger("Could not start Room Scout", {
        description: e.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const stopScout = async (id: string) => {
    setSaving(true);
    try {
      await api.stopRoomScout(id);
      toast.success("Room Scout stopped");
      await load();
    } catch (e: any) {
      toast.danger("Could not stop Room Scout", {
        description: e.message,
      });
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      const res = await api.processRoomScouts();
      toast.success("Room Scout check completed", {
        description: `${res.checked} checked, ${res.notified} emailed, ${res.matches} match(es).`,
      });
      await load();
    } catch (e: any) {
      toast.danger("Room Scout check failed", {
        description: e.message,
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-default-200 px-6 py-4">
        <div>
          <h1 className="text-xl font-semibold text-default-900">Room Scout</h1>
          <p className="mt-1 text-sm text-default-500">Runs at :01 and :31</p>
        </div>
        <Button
          variant="secondary"
          className="rounded-full"
          isPending={running}
          onPress={runNow}
        >
          <ArrowsRotateRight className="size-4" />
          Run check
        </Button>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-0 overflow-y-auto lg:grid-cols-[360px_1fr]">
        <section className="border-b border-default-200 p-6 lg:border-b-0 lg:border-r">
          <div className="space-y-5">
            <div>
              <label className="mb-2 block text-sm font-medium text-default-700">
                Duration
              </label>
              <Select
                aria-label="Duration"
                variant="secondary"
                selectedKey={duration}
                onSelectionChange={(key) => setDuration(String(key))}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {DURATION_OPTIONS.map((item) => (
                      <ListBoxItem key={item.value} id={item.value}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-default-700">
                Capacity
              </label>
              <input
                value={capacity}
                inputMode="numeric"
                type="number"
                min={1}
                max={200}
                onChange={(event) => setCapacity(event.target.value)}
                className="h-10 w-full rounded-lg border border-default-200 bg-white px-3 text-sm text-default-900 outline-none transition focus:border-default-400 dark:bg-[#0c0e12]"
              />
            </div>

            <div>
              <label className="mb-2 block text-sm font-medium text-default-700">
                Office
              </label>
              <Select
                aria-label="Office"
                variant="secondary"
                selectedKey={office || "all"}
                onSelectionChange={(key) =>
                  setOffice(String(key) === "all" ? "" : String(key))
                }
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    <ListBoxItem id="all">All offices</ListBoxItem>
                    {officeOptions.map((item) => (
                      <ListBoxItem key={item.value} id={item.value}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>

            <Button
              className="w-full rounded-full"
              isPending={saving}
              isDisabled={Boolean(activeScout)}
              onPress={createScout}
            >
              Start Room Scout
            </Button>
          </div>
        </section>

        <section className="min-h-0 p-6">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : scouts.length === 0 ? (
            <EmptyState className="flex h-full flex-col items-center justify-center text-center">
              <div className="text-sm font-medium text-default-600">No Room Scout yet</div>
            </EmptyState>
          ) : (
            <div className="space-y-3">
              {scouts.map((scout) => (
                <div
                  key={scout.id}
                  className="grid gap-4 rounded-lg border border-default-200 p-4 md:grid-cols-[1fr_auto]"
                >
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-base font-semibold text-default-900">
                        {scout.duration_minutes} min for {scout.min_capacity}+ people
                      </h2>
                      <Chip color={statusColor(scout.status) as any} size="sm" variant="soft">
                        <Chip.Label>{scout.status}</Chip.Label>
                      </Chip>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-default-600 sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <span className="block text-default-400">Office</span>
                        {scout.office || "All"}
                      </div>
                      <div>
                        <span className="block text-default-400">Last checked</span>
                        {formatDateTime(scout.last_checked_at)}
                      </div>
                      <div>
                        <span className="block text-default-400">Last email</span>
                        {formatDateTime(scout.last_notified_at)}
                      </div>
                      <div>
                        <span className="block text-default-400">Expires</span>
                        {formatDateTime(scout.expires_at)}
                      </div>
                    </div>
                  </div>

                  {scout.status === "active" && (
                    <Button
                      isIconOnly
                      aria-label="Stop Room Scout"
                      variant="danger"
                      className="size-10 rounded-full"
                      isDisabled={saving}
                      onPress={() => stopScout(scout.id)}
                    >
                      <TrashBin className="size-4" />
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
