import React from "react";
import { observable, makeObservable } from "mobx";

import {
    IMessage,
    MessageType,
    PropertyType,
    getParent,
    makeDerivedClassInfo
} from "project-editor/core/object";

import { ProjectType } from "project-editor/project/project";

import {
    geometryGroup,
    specificGroup
} from "project-editor/ui-components/PropertyGrid/groups";

import { LVGLMessageBoxWidget, LVGLWidget } from "./internal";
import { Message } from "project-editor/store";
import { ProjectEditor } from "project-editor/project-editor-interface";
import type { LVGLCode } from "project-editor/lvgl/to-lvgl-code";
import type { IResizeHandler } from "project-editor/flow/flow-interfaces";

////////////////////////////////////////////////////////////////////////////////

export class LVGLMessageBoxButtonWidget extends LVGLWidget {
    text: string;
    closeButton: boolean;

    static classInfo = makeDerivedClassInfo(LVGLWidget.classInfo, {
        enabledInComponentPalette: (projectType: ProjectType) =>
            projectType === ProjectType.LVGL,

        label: (widget: LVGLMessageBoxButtonWidget) =>
            widget.closeButton
                ? "Close button"
                : widget.text
                ? `Button ${widget.text}`
                : "Button",

        componentPaletteGroupName: "!1Basic",

        properties: [
            // the whole Position and size group is managed by the
            // MessageBox layout
            {
                name: "geometryProperties",
                type: PropertyType.Any,
                propertyGridGroup: geometryGroup,
                computed: true,
                skipSearch: true,
                hideInPropertyGrid: true
            },
            {
                name: "absolutePosition",
                displayName: "Absolute pos.",
                type: PropertyType.String,
                propertyGridGroup: geometryGroup,
                computed: true,
                hideInPropertyGrid: true
            },
            {
                name: "alignAndDistribute",
                type: PropertyType.Any,
                propertyGridGroup: geometryGroup,
                computed: true,
                skipSearch: true,
                hideInPropertyGrid: true
            },
            {
                name: "text",
                type: PropertyType.String,
                propertyGridGroup: specificGroup
            },
            {
                name: "closeButton",
                displayName: "Close button",
                type: PropertyType.Boolean,
                propertyGridGroup: specificGroup,
                checkboxStyleSwitch: true,
                formText:
                    "Creates the close button (with the X icon) instead of a regular text button. On LVGL 8.4 only the first close button is created (one-shot API)."
            }
        ],

        defaultValue: {
            left: 0,
            top: 0,
            width: 80,
            height: 40,
            clickableFlag: true,
            text: "Ok",
            closeButton: false
        },

        icon: (
            <svg viewBox="0 0 24 24">
                <path
                    d="M5 20a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5zm3-4h8v-2H8v2zm0-4h8v-2H8v2z"
                    fill="currentcolor"
                />
            </svg>
        ),

        check: (widget: LVGLMessageBoxButtonWidget, messages: IMessage[]) => {
            if (!widget.messageBox) {
                messages.push(
                    new Message(
                        MessageType.ERROR,
                        `Invalid position of MessageBox button widget inside Widgets Structure`,
                        widget
                    )
                );
            }
        },

        lvgl: {
            parts: ["MAIN"],
            defaultFlags:
                "CLICKABLE|CLICK_FOCUSABLE|GESTURE_BUBBLE|PRESS_LOCK|SCROLL_CHAIN_HOR|SCROLL_CHAIN_VER|SCROLL_ELASTIC|SCROLL_MOMENTUM|SCROLL_ON_FOCUS|SCROLL_WITH_ARROW|SNAPPABLE"
        }
    });

    override makeEditable() {
        super.makeEditable();

        makeObservable(this, {
            text: observable,
            closeButton: observable
        });
    }

    get parentWidget() {
        return getParent(getParent(this)) as LVGLWidget;
    }

    get messageBox() {
        const parent = this.parentWidget;
        if (parent instanceof LVGLMessageBoxWidget) {
            return parent;
        }
        return undefined;
    }

    // The button object lives inside an internal MessageBox layout
    // container (footer for text buttons, header for the close button),
    // so the position relative to the immediate LVGL parent has to be
    // walked up to the MessageBox itself for the editor overlay.
    override get relativePosition() {
        const position = { ...super.relativePosition };

        const obj = this._lvglObj;
        const messageBoxObj = this.messageBox?._lvglObj;
        if (obj && messageBoxObj) {
            const page = ProjectEditor.getPage(this) as any;
            const runtime = page?._lvglRuntime;
            if (runtime && runtime.isMounted) {
                try {
                    const wasm = runtime.wasm;
                    let parent = wasm._lv_obj_get_parent(obj);
                    while (parent && parent != messageBoxObj) {
                        position.left += wasm._lv_obj_get_x(parent);
                        position.top += wasm._lv_obj_get_y(parent);
                        parent = wasm._lv_obj_get_parent(parent);
                    }
                } catch (e) {}
            }
        }

        return position;
    }

    // size is determined by content and the MessageBox layout
    override getResizeHandlers(): IResizeHandler[] | undefined | false {
        return false;
    }

    override toLVGLCode(code: LVGLCode) {        if (!this.messageBox) {
            code.createObject("lv_obj_create");
            return;
        }

        if (code.isV9) {
            if (this.closeButton) {
                code.getObject("lv_msgbox_add_close_button");
            } else {
                code.getObject(
                    "lv_msgbox_add_footer_button",
                    code.stringProperty("literal", this.text ?? "")
                );
            }
        } else {
            // LVGL 8.4: buttons are created in one shot by
            // lv_msgbox_create() from the texts collected by the MessageBox
            // widget itself, nothing to do here
        }
    }
}
