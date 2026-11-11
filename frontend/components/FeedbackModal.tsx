"use client";

import { Modal } from "@heroui/react";
import { useT } from "@/app/providers";

/** The feedback form (Microsoft Forms), opened from the sidebar's "Feedback" row. */
export function FeedbackModal({
  isOpen,
  onOpenChange,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
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
  );
}
