import assert from "node:assert/strict";
import test from "node:test";
import {
  focusInitialElement,
  handleModalKeyDown,
  registerModal,
  restoreModalFocus,
  trapModalFocus,
} from "./Modal";

test("verify to setup replacement focuses the new stage preferred control", () => {
  withFakeDom(({ body, createElement, setActiveElement }) => {
    const closeButton = createElement();
    const setupCodeInput = createElement(["data-modal-initial-focus"]);
    const dialog = createElement([], [closeButton, setupCodeInput]);
    setActiveElement(body);

    focusInitialElement(dialog as unknown as HTMLElement);

    assert.equal(activeElement(), setupCodeInput);
  });
});

test("focus trap pulls Tab and Shift+Tab back when focus escaped the dialog", () => {
  withFakeDom(({ body, createElement, setActiveElement }) => {
    const first = createElement();
    const last = createElement();
    const dialog = createElement([], [first, last]);
    let prevented = 0;

    setActiveElement(body);
    trapModalFocus(
      { preventDefault: () => { prevented += 1; }, shiftKey: false },
      dialog as unknown as HTMLElement,
    );
    assert.equal(activeElement(), first);

    setActiveElement(body);
    trapModalFocus(
      { preventDefault: () => { prevented += 1; }, shiftKey: true },
      dialog as unknown as HTMLElement,
    );
    assert.equal(activeElement(), last);
    assert.equal(prevented, 2);
  });
});

test("only the top nested modal handles Escape and disabled close stays blocked", () => {
  withFakeDom(({ createElement }) => {
    const parentId = Symbol("parent");
    const childId = Symbol("child");
    const unregisterParent = registerModal(parentId);
    const unregisterChild = registerModal(childId);
    const dialog = createElement();
    let parentCloses = 0;
    let childCloses = 0;
    let prevented = 0;
    const escapeEvent = {
      key: "Escape",
      preventDefault: () => { prevented += 1; },
      shiftKey: false,
    };

    handleModalKeyDown(escapeEvent, parentId, dialog as unknown as HTMLElement, false, () => { parentCloses += 1; });
    handleModalKeyDown(escapeEvent, childId, dialog as unknown as HTMLElement, true, () => { childCloses += 1; });
    assert.equal(parentCloses, 0);
    assert.equal(childCloses, 0);

    handleModalKeyDown(escapeEvent, childId, dialog as unknown as HTMLElement, false, () => { childCloses += 1; });
    assert.equal(childCloses, 1);
    assert.equal(prevented, 1);

    unregisterChild();
    handleModalKeyDown(escapeEvent, parentId, dialog as unknown as HTMLElement, false, () => { parentCloses += 1; });
    assert.equal(parentCloses, 1);
    unregisterParent();
  });
});

test("closing a modal restores focus to the element that opened it", () => {
  withFakeDom(({ body, createElement, setActiveElement }) => {
    const trigger = createElement();
    setActiveElement(body);

    restoreModalFocus(trigger as unknown as Element);

    assert.equal(activeElement(), trigger);
  });
});

type FakeDom = {
  body: FakeElement;
  createElement: (attributes?: string[], focusables?: FakeElement[]) => FakeElement;
  setActiveElement: (element: FakeElement) => void;
};

class FakeElement {
  private readonly attributes: Set<string>;
  private readonly focusables: FakeElement[];

  constructor(attributes: string[] = [], focusables: FakeElement[] = []) {
    this.attributes = new Set(attributes);
    this.focusables = focusables;
  }

  contains(element: unknown) {
    return element === this || this.focusables.includes(element as FakeElement);
  }

  focus() {
    setActiveElement(this);
  }

  getAttribute(name: string) {
    return this.attributes.has(name) ? "" : null;
  }

  hasAttribute(name: string) {
    return this.attributes.has(name);
  }

  querySelector<T>() {
    return (this.focusables.find((element) => element.hasAttribute("data-modal-initial-focus")) ?? null) as T | null;
  }

  querySelectorAll<T>() {
    return this.focusables as T[];
  }
}

let currentActiveElement: FakeElement | null = null;

function activeElement() {
  return currentActiveElement;
}

function setActiveElement(element: FakeElement) {
  currentActiveElement = element;
}

function withFakeDom(run: (dom: FakeDom) => void) {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const originalHTMLElement = Object.getOwnPropertyDescriptor(globalThis, "HTMLElement");
  const body = new FakeElement();
  currentActiveElement = body;

  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get activeElement() {
        return currentActiveElement;
      },
    },
  });
  Object.defineProperty(globalThis, "HTMLElement", {
    configurable: true,
    value: FakeElement,
  });

  try {
    run({
      body,
      createElement: (attributes = [], focusables = []) => new FakeElement(attributes, focusables),
      setActiveElement,
    });
  } finally {
    currentActiveElement = null;
    restoreGlobal("document", originalDocument);
    restoreGlobal("HTMLElement", originalHTMLElement);
  }
}

function restoreGlobal(name: "document" | "HTMLElement", descriptor?: PropertyDescriptor) {
  if (descriptor) {
    Object.defineProperty(globalThis, name, descriptor);
  } else {
    Reflect.deleteProperty(globalThis, name);
  }
}
