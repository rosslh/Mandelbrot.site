// A minimal confirmation dialog sharing the app's modal markup and styles
// (a <dialog> + form with a submit/cancel pair). Unlike FormModal it runs no
// async task, so it takes its confirm/cancel callbacks per-open: the caller
// supplies what to do on confirm and how to restore state on cancel.

type ConfirmModalElements = {
  dialogId: string;
  formId: string;
  cancelId: string;
};

class ConfirmModal {
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly cancelButton: HTMLButtonElement;
  private onConfirm?: () => void;
  private onCancel?: () => void;

  constructor(elements: ConfirmModalElements) {
    this.dialog = document.getElementById(
      elements.dialogId,
    ) as HTMLDialogElement;
    this.form = document.getElementById(elements.formId) as HTMLFormElement;
    this.cancelButton = document.getElementById(
      elements.cancelId,
    ) as HTMLButtonElement;

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.resolve(this.onConfirm);
    });

    // Cancel-button clicks and dismissals (Escape, backdrop) both count as
    // declining the confirmation.
    this.cancelButton.onclick = () => this.resolve(this.onCancel);
    this.dialog.addEventListener("cancel", () => this.resolve(this.onCancel));
  }

  open(onConfirm: () => void, onCancel: () => void) {
    if (this.dialog.open) {
      return;
    }
    this.onConfirm = onConfirm;
    this.onCancel = onCancel;
    this.dialog.showModal();
  }

  /** Closes the modal and runs the chosen outcome exactly once. */
  private resolve(handler?: () => void) {
    // Clear the callbacks first so the dialog's own "cancel" event (fired as
    // close() runs) can't re-trigger the outcome.
    this.onConfirm = undefined;
    this.onCancel = undefined;
    if (this.dialog.open) {
      this.dialog.close();
    }
    handler?.();
  }
}

export default ConfirmModal;
