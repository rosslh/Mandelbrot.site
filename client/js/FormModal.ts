// Wraps a <dialog> + form with the busy-state choreography the app's modals
// share: while a submitted task runs, the submit and cancel buttons are
// disabled, Escape and resubmission are ignored, and the submit button's
// label reports progress. Built for the save-image modal; reusable by any
// modal that runs an async task on submit (zoom animations, confirmations).

type FormModalElements = {
  dialogId: string;
  formId: string;
  submitId: string;
  cancelId: string;
};

type FormModalHandlers = {
  // Prepares the form's fields; runs each time the modal opens.
  onOpen?: () => void;
  // Runs on a valid submit while idle. The handler is responsible for
  // calling beginBusy/finishBusy around any async work.
  onSubmit: () => void;
};

class FormModal {
  readonly dialog: HTMLDialogElement;
  readonly form: HTMLFormElement;
  readonly submitButton: HTMLButtonElement;
  readonly cancelButton: HTMLButtonElement;
  private busy = false;
  private idleSubmitLabel: string;
  private onOpen?: () => void;

  constructor(elements: FormModalElements, handlers: FormModalHandlers) {
    this.dialog = document.getElementById(
      elements.dialogId,
    ) as HTMLDialogElement;
    this.form = document.getElementById(elements.formId) as HTMLFormElement;
    this.submitButton = document.getElementById(
      elements.submitId,
    ) as HTMLButtonElement;
    this.cancelButton = document.getElementById(
      elements.cancelId,
    ) as HTMLButtonElement;
    this.idleSubmitLabel = this.submitButton.innerText;

    this.form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (!this.busy) {
        handlers.onSubmit();
      }
    });

    // Escape while busy: the running task can't be cancelled, so neither
    // can the dialog.
    this.dialog.addEventListener("cancel", (event) => {
      if (this.busy) {
        event.preventDefault();
      }
    });

    this.cancelButton.onclick = () => this.close();
    this.onOpen = handlers.onOpen;
  }

  get isBusy(): boolean {
    return this.busy;
  }

  toggle() {
    if (this.dialog.open) {
      this.close();
    } else {
      this.open();
    }
  }

  open() {
    if (this.busy || this.dialog.open) {
      return;
    }
    this.onOpen?.();
    this.dialog.showModal();
  }

  close() {
    if (this.busy) {
      return;
    }
    this.dialog.close();
  }

  /** Locks the modal for the duration of a task and shows its progress on
   * the submit button. */
  beginBusy(label: string) {
    this.busy = true;
    this.submitButton.innerText = label;
    this.submitButton.setAttribute("disabled", "true");
    this.cancelButton.setAttribute("disabled", "true");
  }

  /** Updates the progress label mid-task (e.g. "Generating…" →
   * "Optimizing…"). */
  setBusyLabel(label: string) {
    this.submitButton.innerText = label;
  }

  /** Unlocks the modal and closes it; the next open starts idle. */
  finishBusy() {
    this.busy = false;
    this.submitButton.innerText = this.idleSubmitLabel;
    this.submitButton.removeAttribute("disabled");
    this.cancelButton.removeAttribute("disabled");
    this.dialog.close();
  }
}

export default FormModal;
