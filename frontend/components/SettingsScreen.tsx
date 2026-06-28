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
  Modal,
  ListBoxItem,
  SearchField,
  Select,
  Switch,
  Tag,
  TagGroup,
  TextField,
  toast,
  useFilter,
} from "@heroui/react";
import { Comment } from "@gravity-ui/icons";
import {
  api,
  type Language,
  type Me,
  type ThemeMode,
  type UserProfileOption,
  type UserProfileOptions,
} from "@/lib/api";
import { useLanguage, useTheme } from "@/app/providers";
import { LANGUAGE_OPTIONS } from "@/lib/i18n";

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

const THEME_CARDS: { mode: ThemeMode; srcKey: string }[] = [
  { mode: "system", srcKey: "/theme-system.svg" },
  { mode: "light", srcKey: "/theme-light.svg" },
  { mode: "dark", srcKey: "/theme-dark.svg" },
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
  onDirtyChange,
  discardRef,
  saveRef,
}: {
  me: Me;
  onSaved: (me: Me) => void;
  onDirtyChange?: (dirty: boolean) => void;
  discardRef?: { current: (() => void) | null };
  saveRef?: { current: (() => Promise<boolean>) | null };
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
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Theme + language are applied live (and persisted) through global providers;
  // we still track the last-saved values below so Cancel can revert them.
  const { theme, setTheme } = useTheme();
  const { language, setLanguage, t } = useLanguage();

  // Baseline snapshot of the form so Save only enables on a real change (and
  // disables again if the user reverts back to the original values).
  const initial = useRef({
    office: me.profile?.office ?? "",
    floor: me.profile?.floor ?? "",
    building: me.profile?.building ?? "",
    preferredRooms: [...(me.profile?.preferred_rooms ?? [])],
    bookWithoutConfirmation: me.profile?.book_without_confirmation ?? false,
    theme: (me.profile?.theme ?? "system") as ThemeMode,
    language: (me.profile?.language ?? "en") as Language,
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
  const displayName = emailUsername || me.username || t("common.user");

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

  // Expose the latest reset closure so the parent can discard unsaved changes
  // (including the live-applied theme) before navigating away from Settings.
  const resetFormRef = useRef(resetForm);
  resetFormRef.current = resetForm;
  useEffect(() => {
    if (discardRef) discardRef.current = () => resetFormRef.current();
    return () => {
      if (discardRef) discardRef.current = null;
    };
  }, [discardRef]);

  // Report dirty state up so the parent can warn before leaving Settings.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

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

  const submitProfile = async (): Promise<boolean> => {
    if (!canSave) return false;
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
        language,
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
      toast.success(t("settings.saved"), {
        description: t("settings.savedDesc"),
      });
      return true;
    } catch (e: any) {
      setErr(e.message);
      toast.danger(t("settings.saveFailed"), {
        description:
          e.message === "UNAUTHENTICATED"
            ? t("settings.saveFailedAuth")
            : t("settings.saveFailedGeneric"),
      });
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Expose the latest save closure so the parent can "Save and leave" directly
  // from the unsaved-changes prompt. Returns whether the save succeeded.
  const submitProfileRef = useRef(submitProfile);
  submitProfileRef.current = submitProfile;
  useEffect(() => {
    if (saveRef) saveRef.current = () => submitProfileRef.current();
    return () => {
      if (saveRef) saveRef.current = null;
    };
  }, [saveRef]);

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
              title={t("settings.personalInfo")}
              description={t("settings.personalInfoDesc")}
            />
            <div className="flex min-w-[280px] flex-1 flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <TextField fullWidth isDisabled>
                  <Label>{t("settings.domain")} {req}</Label>
                  <Input variant="secondary" value={emailUsername} />
                </TextField>
                <TextField fullWidth isDisabled>
                  <Label>{t("settings.email")} {req}</Label>
                  <Input variant="secondary" value={email} />
                </TextField>
              </div>

              <Select
                variant="secondary"
                className="flex flex-col gap-2"
                placeholder={t("settings.chooseOffice")}
                selectedKey={office || null}
                onSelectionChange={changeOffice}
                isRequired
                isDisabled={optionsLoading}
              >
                <Label>{t("settings.office")}</Label>
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
                  placeholder={t("settings.chooseFloor")}
                  selectedKey={floor || null}
                  onSelectionChange={(key) => setFloor((key as string) ?? "")}
                  isDisabled={!isCampus || optionsLoading}
                >
                  <Label>{t("settings.floor")}</Label>
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
                  placeholder={t("settings.chooseBuilding")}
                  selectedKey={building || null}
                  onSelectionChange={(key) => setBuilding((key as string) ?? "")}
                  isDisabled={!isCampus || optionsLoading}
                >
                  <Label>{t("settings.building")}</Label>
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
                placeholder={t("settings.preferredRoomsPlaceholder")}
                selectionMode="multiple"
                value={preferredRooms}
                onChange={updatePreferredRooms}
                isDisabled={!office || optionsLoading}
              >
                <Label>{t("settings.preferredRooms")}</Label>
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
                        aria-label={t("settings.preferredRooms")}
                        name="search"
                        variant="secondary"
                        fullWidth
                      >
                        <SearchField.Group>
                          <SearchField.SearchIcon />
                          <SearchField.Input
                            placeholder={t("settings.preferredRoomsPlaceholder")}
                          />
                          <SearchField.ClearButton />
                        </SearchField.Group>
                      </SearchField>
                    </div>
                    <ListBox
                      className="max-h-[200px] overflow-y-auto"
                      renderEmptyState={() => (
                      <EmptyState>{t("settings.noResults")}</EmptyState>
                    )}
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
              title={t("settings.bookingConfirmation")}
              description={t("settings.bookingConfirmationDesc")}
            />
            <div className="flex min-w-[280px] flex-1 items-center gap-3">
              <Switch
                isSelected={bookWithoutConfirmation}
                onChange={setBookWithoutConfirmation}
              >
                <Switch.Content>
                  <Switch.Control>
                    <Switch.Thumb />
                  </Switch.Control>
                </Switch.Content>
              </Switch>
              <span className="text-sm font-medium text-[#18181b] dark:text-[#f7f7f7]">
                {bookWithoutConfirmation
                  ? t("settings.bookingOn")
                  : t("settings.bookingOff")}
              </span>
            </div>
          </div>

          <div className="h-px w-full bg-[#e9eaeb] dark:bg-[#373a41]" />

          {/* Display preference (mock) */}
          <div className="flex flex-wrap items-start gap-x-8 gap-y-4">
            <SectionLabel
              title={t("settings.displayPreference")}
              description={t("settings.displayPreferenceDesc")}
            />
            <div className="flex flex-1 flex-wrap gap-5">
              {THEME_CARDS.map((card) => (
                <ThemeCard
                  key={card.mode}
                  mode={card.mode}
                  label={t(
                    card.mode === "system"
                      ? "settings.themeSystem"
                      : card.mode === "light"
                        ? "settings.themeLight"
                        : "settings.themeDark",
                  )}
                  src={card.srcKey}
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
              title={t("settings.language")}
              description={t("settings.languageDesc")}
            />
            <div className="flex flex-1">
              <Select
                variant="secondary"
                className="flex w-[256px] flex-col gap-2"
                selectedKey={language}
                onSelectionChange={(key) =>
                  setLanguage((key as Language) ?? "en")
                }
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
          <div className="flex items-center justify-between gap-2 py-4">
            <Button
              variant="tertiary"
              className="rounded-full"
              onPress={() => setFeedbackOpen(true)}
            >
              <Comment className="size-4" />
              {t("settings.feedback")}
            </Button>
            <div className="flex items-center gap-2">
            <Button
              variant="tertiary"
              className="rounded-full"
              onPress={resetForm}
              isDisabled={busy || !dirty}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="rounded-full"
              isDisabled={!canSave || optionsLoading || !dirty}
              isPending={busy}
              onPress={submitProfile}
            >
              {t("common.save")}
            </Button>
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={feedbackOpen} onOpenChange={setFeedbackOpen}>
        <Modal.Backdrop>
          <Modal.Container size="cover">
            <Modal.Dialog className="flex flex-col">
              <Modal.Header className="flex items-center justify-between">
                <Modal.Heading>{t("settings.feedbackTitle")}</Modal.Heading>
                <Modal.CloseTrigger />
              </Modal.Header>
              <Modal.Body className="flex-1 p-0">
                <iframe
                  title={t("settings.feedbackTitle")}
                  src="https://forms.office.com/r/tqXL5RYBqM?embed=true"
                  className="h-full min-h-[480px] w-full border-0"
                  allowFullScreen
                />
              </Modal.Body>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  );
}
