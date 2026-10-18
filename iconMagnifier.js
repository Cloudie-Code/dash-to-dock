// -*- mode: js; js-indent-level: 4; indent-tabs-mode: nil -*-

import {
    Clutter,
    St,
} from './dependencies/gi.js';

import {Dash} from './dependencies/shell/ui.js';

import {
    Docking,
    Utils,
} from './imports.js';

const MAGNIFY_ANIMATION_TIME = 150;

// Radius, in icon sizes, of the area around the pointer whose icons get magnified.
const MAGNIFY_SPREAD = 2.5;

// Upper bound of the dash item size (icon plus its padding) relative to the icon size.
const ITEM_TO_ICON_SIZE_RATIO = 2;

/**
 * Magnify the dash icons around the pointer, like the macOS dock.
 *
 * Icons are only transformed (scaled and translated), so the dash layout,
 * and thus the dock size and struts, are not affected by the magnification.
 */
export class IconMagnifier {
    constructor(dash) {
        this._dash = dash;
        this._pointer = null;
        this._inhibited = false;
        this._targetProgress = 0;
        this._transformedActors = new Map(); // actor -> destroy handler id

        this._progress = new St.Adjustment({
            actor: dash,
            lower: 0,
            upper: 1,
            value: 0,
        });

        const {settings} = Docking.DockManager;
        // No parent object: the dash signals must be disconnected in destroy(),
        // before the dash children are destroyed.
        this._signalsHandler = new Utils.GlobalSignalsHandler();
        this._signalsHandler.add([
            this._progress,
            'notify::value',
            () => this._update(),
        ], [
            dash,
            'motion-event',
            (_actor, event) => this._onMotionEvent(event),
        ], [
            dash,
            'leave-event',
            (_actor, event) => this._onLeaveEvent(event),
        ], [
            settings,
            'changed::hover-zoom',
            () => this.reset(false),
        ], [
            settings,
            'changed::hover-zoom-scale',
            () => this._update(),
        ]);
    }

    destroy() {
        this._signalsHandler.destroy();
        this._progress.remove_transition('value');
        // The icons are destroyed together with the dash, restoring their
        // geometry would only trigger needless pointer crossing events.
        this._transformedActors.forEach((destroyId, actor) =>
            actor.disconnect(destroyId));
        this._transformedActors.clear();
    }

    /**
     * Space required around the dash to draw the magnified icons.
     *
     * The magnified icons push their neighbours by up to the scale increase
     * times the magnification spread, and the dash items are bigger than the
     * icons themselves because of their padding, so be generous here.
     */
    static getOverflowSize(iconSize) {
        const {settings} = Docking.DockManager;
        if (!settings.hoverZoom)
            return 0;

        const itemSize = iconSize * ITEM_TO_ICON_SIZE_RATIO;
        return Math.ceil(itemSize * (settings.hoverZoomScale - 1) * MAGNIFY_SPREAD);
    }

    get enabled() {
        return Docking.DockManager.settings.hoverZoom && !this._inhibited;
    }

    set inhibited(inhibited) {
        this._inhibited = inhibited;
        if (inhibited)
            this.reset(false);
    }

    reset(animate = true) {
        this._targetProgress = 0;
        this._progress.remove_transition('value');

        if (animate && this._progress.value > 0) {
            this._progress.ease(0, {
                duration: MAGNIFY_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => (this._pointer = null),
            });
        } else {
            this._pointer = null;
            this._progress.value = 0;
            this._update();
        }
    }

    _onMotionEvent(event) {
        if (!this.enabled)
            return Clutter.EVENT_PROPAGATE;

        this._pointer = event.get_coords();

        if (this._targetProgress !== 1) {
            this._targetProgress = 1;
            this._progress.ease(1, {
                duration: MAGNIFY_ANIMATION_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        }

        this._update();

        return Clutter.EVENT_PROPAGATE;
    }

    _onLeaveEvent(event) {
        const related = event.get_related();
        if (!related || !this._dash.contains(related))
            this.reset();

        return Clutter.EVENT_PROPAGATE;
    }

    _getItems() {
        const dash = this._dash;
        const items = [];

        const addItem = actor => {
            if (!actor?.visible || !actor.get_stage())
                return;

            if (actor instanceof Dash.DashItemContainer) {
                if (actor.child && !actor.animatingOut && actor !== dash._dragPlaceholder)
                    items.push({target: actor.child, geometry: actor, scalable: true});
            } else if (actor === dash._separator) {
                items.push({target: actor, geometry: actor, scalable: false});
            }
        };

        dash._box.get_children().forEach(addItem);
        addItem(dash._showAppsIcon);

        return items;
    }

    _isViewportScrollable() {
        const viewport = this._dash._boxContainer;
        const adjustment = this._dash._isHorizontal
            ? viewport.hadjustment : viewport.vadjustment;

        return adjustment && adjustment.upper - adjustment.lower > adjustment.page_size;
    }

    _updateViewportClip(magnifying) {
        // Magnified icons need to overflow the viewport, but keep it clipped
        // when scrolling is in use, or the icons out of view would be shown.
        const viewport = this._dash._boxContainer;
        const clipToView = !magnifying || this._isViewportScrollable();
        if (viewport.clip_to_view !== clipToView)
            viewport.clip_to_view = clipToView;
    }

    _getPivotPoint() {
        switch (this._dash._position) {
        case St.Side.TOP:
            return [0.5, 0];
        case St.Side.LEFT:
            return [0, 0.5];
        case St.Side.RIGHT:
            return [1, 0.5];
        default:
            return [0.5, 1];
        }
    }

    _resetActor(actor, destroyId) {
        actor.disconnect(destroyId);
        actor.set({
            scale_x: 1,
            scale_y: 1,
            translation_x: 0,
            translation_y: 0,
        });
    }

    _update() {
        const progress = this._progress.value;
        const items = progress > 0 && this._pointer ? this._getItems() : [];

        const previousActors = this._transformedActors;
        this._transformedActors = new Map();
        items.forEach(({target}) => {
            let destroyId = previousActors.get(target);
            if (destroyId)
                previousActors.delete(target);
            else
                destroyId = target.connect('destroy', () => this._transformedActors.delete(target));
            this._transformedActors.set(target, destroyId);
        });
        previousActors.forEach((destroyId, actor) => this._resetActor(actor, destroyId));

        this._updateViewportClip(items.length > 0);

        if (!items.length)
            return;

        const isHorizontal = this._dash._isHorizontal;
        const [pointerX, pointerY] = this._pointer;
        const pointer = isHorizontal ? pointerX : pointerY;
        const [pivotX, pivotY] = this._getPivotPoint();

        items.forEach(item => {
            const {target, geometry} = item;
            const extents = geometry.get_transformed_extents();

            // Our own translation must not affect the computed position
            const ownTranslation = target === geometry
                ? (isHorizontal ? target.translation_x : target.translation_y) : 0;
            const start = (isHorizontal ? extents.get_x() : extents.get_y()) - ownTranslation;

            item.length = isHorizontal ? extents.get_width() : extents.get_height();
            item.distance = start + item.length / 2 - pointer;
        });

        const itemLength = Math.max(...items.filter(i => i.scalable).map(i => i.length));
        const spread = MAGNIFY_SPREAD * itemLength;
        const amount = (Docking.DockManager.settings.hoverZoomScale - 1) * progress;

        // The dash behaves like a lens centered on the pointer: the local
        // magnification smoothly decreases from the pointer up to the spread
        // distance, and each point of the dash is moved by the integral of the
        // extra magnification between the pointer and it. So the point under
        // the pointer never moves, and the icons stay contiguous and change
        // smoothly as the pointer moves.
        const magnifiedOffset = offset => {
            const clamped = Math.clamp(offset, -spread, spread);
            return (clamped + spread / Math.PI * Math.sin(Math.PI * clamped / spread)) / 2;
        };

        items.forEach(item => {
            const {target} = item;
            const startOffset = magnifiedOffset(item.distance - item.length / 2);
            const endOffset = magnifiedOffset(item.distance + item.length / 2);

            const scale = item.scalable && item.length > 0
                ? 1 + amount * (endOffset - startOffset) / item.length : 1;
            const translation = amount * (startOffset + endOffset) / 2;

            target.set_pivot_point(pivotX, pivotY);
            target.set({
                scale_x: scale,
                scale_y: scale,
                translation_x: isHorizontal ? translation : 0,
                translation_y: isHorizontal ? 0 : translation,
            });
        });
    }
}
