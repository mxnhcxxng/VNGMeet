"use client";

import type { ReactNode } from "react";
import { Modal } from "@heroui/react";

/**
 * Full-screen viewer (HeroUI Modal, size="full") for maps and other images.
 * Children fill the area below the header; click outside / Esc / ✕ closes.
 */
export function Lightbox({
  isOpen,
  onOpenChange,
  title,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  children: ReactNode;
}) {
  return (
    <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
      <Modal.Backdrop isDismissable>
        <Modal.Container size="full">
          <Modal.Dialog className="flex h-full flex-col">
            <Modal.Header className="flex items-center justify-between">
              <Modal.Heading>{title}</Modal.Heading>
              <Modal.CloseTrigger />
            </Modal.Header>
            <Modal.Body className="relative min-h-0 flex-1 p-0">{children}</Modal.Body>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
