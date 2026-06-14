"use client";

import { useEffect, useRef, useState } from "react";
import {
  Autocomplete,
  Button,
  Chip,
  EmptyState,
  Input,
  type Key,
  Label,
  ListBox,
  ListBoxItem,
  SearchField,
  Select,
  Switch,
  Tag,
  TagGroup,
  TextField,
  useFilter,
} from "@heroui/react";
import {
  api,
  type Me,
  type ThemeMode,
  type UserProfileOption,
  type UserProfileOptions,
} from "@/lib/api";
import { useTheme } from "@/app/providers";

// --- Display preference ------------------------------------------------------

// Each card is the exported Figma preview thumbnail (200×132, includes its own
// rounded border). Selection adds an orange ring + dot on top.
function ThemeCard({
  mode,
  label,
  src,
  selected,
  onSelect,
}: {
  mode: ThemeMode;
  label: string;
  src: string;
  selected: boolean;
  onSelect: (mode: ThemeMode) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(mode)}
      className="flex max-w-[240px] flex-col items-start gap-3 text-left"
    >
      <div
        className={`relative h-[132px] w-[200px] overflow-hidden rounded-[10px] transition-shadow ${
          selected
            ? "shadow-[0px_0px_0px_2px_#ffffff,0px_0px_0px_4px_#f05a22] dark:shadow-[0px_0px_0px_2px_#0c0e12,0px_0px_0px_4px_#f05a22]"
            : ""
        }`}
      >
        <img
          src={src}
          alt={label}
          width={200}
          height={132}
          draggable={false}
          className="h-full w-full select-none"
        />
        {selected && (
          <span className="absolute bottom-2 left-2 flex h-5 w-5 items-center justify-center rounded-full bg-[#f05a22]">
            <span className="h-1.5 w-1.5 rounded-full bg-white" />
          </span>
        )}
      </div>
      <span className="w-full text-sm font-semibold text-[#181d27] dark:text-[#f7f7f7]">
        {label}
      </span>
    </button>
  );
}

const THEME_CARDS: { mode: ThemeMode; label: string; src: string }[] = [
  { mode: "system", label: "System preference", src: "/theme-system.svg" },
  { mode: "light", label: "Light mode", src: "/theme-light.svg" },
  { mode: "dark", label: "Dark mode", src: "/theme-dark.svg" },
];

// --- Language (mock data, FE-only — not persisted) ---------------------------

const LANGUAGE_OPTIONS = [
  { value: "en", label: "English" },
  { value: "vi", label: "Tiếng Việt" },
];

// --- Section scaffolding -----------------------------------------------------

function SectionLabel({ title, description }: { title: string; description: string }) {
  return (
    <div className="flex min-w-[200px] max-w-[280px] flex-1 flex-col">
      <p className="text-sm font-medium text-[#18181b] dark:text-[#f7f7f7]">{title}</p>
      <p className="text-sm text-[#71717a] dark:text-[#94979c]">{description}</p>
    </div>
  );
}

export function SettingsScreen({
  me,
  onSaved,
}: {
  me: Me;
  onSaved: (me: Me) => void;
}) {
  const [office, setOffice] = useState(me.profile?.office ?? "");
  const [floor, setFloor] = useState(me.profile?.floor ?? "");
  const [building, setBuilding] = useState(me.profile?.building ?? "");
  const [preferredRooms, setPreferredRooms] = useState<string[]>(
    me.profile?.preferred_rooms ?? []
  );
  const [bookWithoutConfirmation, setBookWithoutConfirmation] = useState(
    me.profile?.book_without_confirmation ?? false
  );
  const [options, setOptions] = useState<UserProfileOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Theme is applied live (and persisted) through the global provider; we still
  // track the last-saved value below so Cancel can revert it.
  const { theme, setTheme } = useTheme();
  // Language stays FE-only for now (not persisted to the backend).
  const [language, setLanguage] = useState("en");

  // Baseline snapshot of the form so Save only enables on a real change (and
  // disables again if the user reverts back to the original values).
  const initial = useRef({
    office: me.profile?.office ?? "",
    floor: me.profile?.floor ?? "",
    building: me.profile?.building ?? "",
    preferredRooms: [...(me.profile?.preferred_rooms ?? [])],
    bookWithoutConfirmation: me.profile?.book_without_confirmation ?? false,
    theme: (me.profile?.theme ?? "system") as ThemeMode,
    language: "en",
  });

  const email =
    [me.profile?.email, me.email, me.username].find((value) =>
      Boolean(value && value.includes("@"))
    ) ||
    me.profile?.email ||
    me.email ||
    "";
  const emailUsername =
    me.profile?.email_username ||
    (email.includes("@") ? email.split("@", 1)[0] : "");
  const displayName = emailUsername || me.username || "Người dùng";

  const isCampus = office === "campus";
  const floorOptions =
    options?.floor.filter((item) => item.parentValue === office) ?? [];
  const buildingOptions =
    options?.building.filter((item) => item.parentValue === office) ?? [];
  const preferredRoomOptions =
    options?.preferredRooms.filter((item) => item.parentValue === office) ?? [];
  const canSave = Boolean(office);
  const sortedRooms = (rooms: string[]) => [...rooms].sort().join("|");
  const dirty =
    office !== initial.current.office ||
    (isCampus ? floor : "") !== initial.current.floor ||
    (isCampus ? building : "") !== initial.current.building ||
    sortedRooms(preferredRooms) !== sortedRooms(initial.current.preferredRooms) ||
    bookWithoutConfirmation !== initial.current.bookWithoutConfirmation ||
    theme !== initial.current.theme ||
    language !== initial.current.language;
  const { contains } = useFilter({ sensitivity: "base" });

  // Cancel reverts the form back to the last-saved values without leaving the
  // settings screen.
  const resetForm = () => {
    setOffice(initial.current.office);
    setFloor(initial.current.floor);
    setBuilding(initial.current.building);
    setPreferredRooms([...initial.current.preferredRooms]);
    setBookWithoutConfirmation(initial.current.bookWithoutConfirmation);
    setTheme(initial.current.theme);
    setLanguage(initial.current.language);
    setErr(null);
  };

  useEffect(() => {
    const loadOptions = async () => {
      setOptionsLoading(true);
      setErr(null);
      try {
        setOptions(await api.userProfileOptions());
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setOptionsLoading(false);
      }
    };
    loadOptions();
  }, []);

  useEffect(() => {
    if (!isCampus) {
      setFloor("");
      setBuilding("");
    }
  }, [isCampus]);

  const changeOffice = (key: Key | null) => {
    setOffice((key as string) ?? "");
    setPreferredRooms([]);
  };

  const updatePreferredRooms = (keys: readonly Key[]) => {
    setPreferredRooms(keys.map(String).slice(0, 3));
  };

  const removePreferredRoomTags = (keys: Set<Key>) => {
    setPreferredRooms((current) => current.filter((item) => !keys.has(item)));
  };

  const submitProfile = async () => {
    if (!canSave) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await api.updateUserProfile({
        office,
        floor: isCampus ? floor : "",
        building: isCampus ? building : "",
        preferred_rooms: preferredRooms,
        book_without_confirmation: bookWithoutConfirmation,
        theme,
      });
      // New baseline so the button drops back to disabled after a save.
      initial.current = {
        office,
        floor: isCampus ? floor : "",
        building: isCampus ? building : "",
        preferredRooms: [...preferredRooms],
        bookWithoutConfirmation,
        theme,
        language,
      };
      onSaved({
        ...me,
        profile: res.profile,
        profileComplete: res.profileComplete,
      });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const req = <span className="text-danger">*</span>;

  return (
    <div className="h-full overflow-y-auto pb-12">
      {/* Cover image — fills the full horizontal width of the container */}
      <div className="px-1 pt-1">
        <div
          className="h-[200px] w-full rounded-xl bg-cover bg-center"
          style={{ backgroundImage: "url('/profile-cover.png')" }}
        />
      </div>

      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-12">
        <div className="-mt-10 flex items-start gap-5 px-8">
            <div className="flex size-[160px] shrink-0 items-center justify-center rounded-full border border-black/10 dark:border-[#373a41] bg-white dark:bg-[#13161b] p-1.5">
              <img
                src="/default-avatar.jpg"
                alt={displayName || "User"}
                className="size-full rounded-full object-cover"
              />
            </div>
            <div className="flex flex-1 flex-col gap-1 pt-16">
              <p className="text-2xl font-semibold text-[#181d27] dark:text-[#f7f7f7]">{displayName}</p>
              {email && <p className="text-base text-[#535862] dark:text-[#94979c]">{email}</p>}
            </div>
          </div>

        {/* Form sections */}
        <div className="flex flex-col gap-6 px-8">
          {/* Personal info */}
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <SectionLabel
              title="Personal info"
              description="Update your photo and personal details."
            />
            <div className="flex min-w-[280px] flex-1 flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <TextField fullWidth isDisabled>
                  <Label>Domain {req}</Label>
                  <Input variant="secondary" value={emailUsername} />
                </TextField>
                <TextField fullWidth isDisabled>
                  <Label>Email {req}</Label>
                  <Input variant="secondary" value={email} />
                </TextField>
              </div>

              <Select
                variant="secondary"
                className="flex flex-col gap-2"
                placeholder="Choose Office"
                selectedKey={office || null}
                onSelectionChange={changeOffice}
                isRequired
                isDisabled={optionsLoading}
              >
                <Label>Office</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {(options?.office ?? []).map((item) => (
                      <ListBoxItem key={item.value} id={item.value}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <div className="grid grid-cols-2 gap-4">
                <Select
                  variant="secondary"
                  className="flex flex-col gap-2"
                  placeholder="Choose Floor"
                  selectedKey={floor || null}
                  onSelectionChange={(key) => setFloor((key as string) ?? "")}
                  isDisabled={!isCampus || optionsLoading}
                >
                  <Label>Floor</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {floorOptions.map((item) => (
                        <ListBoxItem key={item.value} id={item.value}>
                          {item.label}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
                <Select
                  variant="secondary"
                  className="flex flex-col gap-2"
                  placeholder="Choose Building"
                  selectedKey={building || null}
                  onSelectionChange={(key) => setBuilding((key as string) ?? "")}
                  isDisabled={!isCampus || optionsLoading}
                >
                  <Label>Building</Label>
                  <Select.Trigger>
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {buildingOptions.map((item) => (
                        <ListBoxItem key={item.value} id={item.value}>
                          {item.label}
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              <Autocomplete<UserProfileOption, "multiple">
                variant="secondary"
                fullWidth
                className="flex flex-col gap-2 [&_.autocomplete__trigger]:w-full"
                placeholder="Maximum 3 rooms"
                selectionMode="multiple"
                value={preferredRooms}
                onChange={updatePreferredRooms}
                isDisabled={!office || optionsLoading}
              >
                <Label>Prefered Rooms</Label>
                <Autocomplete.Trigger>
                  <Autocomplete.Value>
                    {({ defaultChildren, isPlaceholder, state }) => {
                      if (isPlaceholder || state.selectedItems.length === 0) {
                        return defaultChildren;
                      }

                      const selectedItemKeys = state.selectedItems.map((item) => item.key);

                      return (
                        <TagGroup
                          size="sm"
                          variant="surface"
                          onRemove={removePreferredRoomTags}
                        >
                          <TagGroup.List>
                            {selectedItemKeys.map((selectedItemKey) => {
                              const item = preferredRoomOptions.find(
                                (room) => room.value === String(selectedItemKey)
                              );

                              if (!item) return null;

                              return (
                                <Tag key={item.value} id={item.value}>
                                  {item.label}
                                </Tag>
                              );
                            })}
                          </TagGroup.List>
                        </TagGroup>
                      );
                    }}
                  </Autocomplete.Value>
                  <Autocomplete.ClearButton />
                  <Autocomplete.Indicator />
                </Autocomplete.Trigger>
                <Autocomplete.Popover className="max-h-[248px] w-[var(--trigger-width)] overflow-y-auto">
                  <Autocomplete.Filter filter={contains}>
                    <div className="w-full px-2 py-2">
                      <SearchField
                        autoFocus
                        aria-label="Search prefered rooms"
                        name="search"
                        variant="secondary"
                        fullWidth
                      >
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input placeholder="Maximum 3 rooms" />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                    </div>
                    <ListBox
                      className="max-h-[200px] overflow-y-auto"
                      renderEmptyState={() => <EmptyState>No results found</EmptyState>}
                    >
                      {preferredRoomOptions.map((item) => (
                        <ListBoxItem
                          key={item.value}
                          id={item.value}
                          textValue={item.label}
                          isDisabled={
                            preferredRooms.length >= 3 &&
                            !preferredRooms.includes(item.value)
                          }
                        >
                          {item.label}
                          <ListBoxItem.Indicator />
                        </ListBoxItem>
                      ))}
                    </ListBox>
                  </Autocomplete.Filter>
                </Autocomplete.Popover>
              </Autocomplete>
            </div>
          </div>

          <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

          {/* Booking confirmation toggle */}
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <SectionLabel
              title="Booking confirmation"
              description="Let the chatbot book a room instantly when you pick one, skipping the in-chat confirmation card."
            />
            <div className="flex min-w-[280px] flex-1 items-center gap-3">
              <Switch
                isSelected={bookWithoutConfirmation}
                onChange={setBookWithoutConfirmation}
              >
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch>
              <span className="text-sm font-medium text-[#18181b] dark:text-[#f7f7f7]">
                {bookWithoutConfirmation
                  ? "Book without confirmation"
                  : "Ask for confirmation"}
              </span>
            </div>
          </div>

          <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

          {/* Display preference (mock) */}
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <SectionLabel
              title="Display preference"
              description="Switch between light and dark modes."
            />
            <div className="flex flex-1 flex-wrap gap-5">
              {THEME_CARDS.map((card) => (
                <ThemeCard
                  key={card.mode}
                  mode={card.mode}
                  label={card.label}
                  src={card.src}
                  selected={theme === card.mode}
                  onSelect={setTheme}
                />
              ))}
            </div>
          </div>

          <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

          {/* Language (mock) */}
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <SectionLabel
              title="Language"
              description="Default language for VNG Meets."
            />
            <div className="flex flex-1">
              <Select
                variant="secondary"
                className="flex w-[256px] flex-col gap-2"
                selectedKey={language}
                onSelectionChange={(key) => setLanguage((key as string) ?? "en")}
              >
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Select.Popover>
                  <ListBox>
                    {LANGUAGE_OPTIONS.map((item) => (
                      <ListBoxItem key={item.value} id={item.value}>
                        {item.label}
                      </ListBoxItem>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>
            </div>
          </div>

          <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

          {err && (
            <Chip color="danger" variant="soft" size="sm" className="self-start">
              {err}
            </Chip>
          )}

          {/* Footer buttons */}
          <div className="flex items-center justify-end gap-2 py-4">
            <Button
              variant="tertiary"
              className="rounded-full"
              onPress={resetForm}
              isDisabled={busy || !dirty}
            >
              Cancel
            </Button>
            <Button
              className="rounded-full"
              isDisabled={!canSave || optionsLoading || !dirty}
              isPending={busy}
              onPress={submitProfile}
            >
              Save changes
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
