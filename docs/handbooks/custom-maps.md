# Custom maps and architectural assemblies

Read get_authoring_guide({topic:'custom-maps'}) and mapAssembly.ts/mapAssemblyView.ts. Use editable recipes and stable IDs. compileBuilding, fixtures and compileTerrainVolumes remain useful; randomness is optional. Use the materials guide for textures.

Compile outside gameplay ticks; share geometry between view and authoritative collision. Relative placement is not contact: validate mating surfaces, separation, overlap and orientation. A suspended lamp needs a visible chain/bracket with connected ends. Roofs, including flat boxes, default to two underside bearing strips; connect walls/beams/posts. Following a parent is not support proof. These are geometric checks, not structural engineering.

Use material regions for owned flooring. Check cross-component near-coplanar faces; tiny Y offsets do not fix duplicates. Preserve stacked floors and deliberate overlays. Check outward roof faces; double-sided materials do not repair reversed solids.

Give signs viewing approaches and clear text regions. Read failures and incomplete coverage. Unknown geometry, omitted checks and exhausted budgets are not passes. Preserve IDs; do not delete requested parts or move gameplay cover merely to clear warnings.

Inspect the saved revision with normal materials/culling: roofs outside, fixture joints, signs, surface joins and vertical routes. review_change's three scenarios cannot cover an entire map; retain unchecked areas. Staged views are separate from legal-input traversal and live performance. Repeat affected checks after edits.

No automatic gameplay obstacle solver is installed. Find the actual camera policy. InspectionFocusController only frames review views; PlayerAppearanceHost.withHiddenFromCamera only masks the body. Test normal routes, doorway/corner turns, near-plane edges and recovery from inside geometry. A center ray alone is insufficient.

Static validation does not certify runtime mutation, renderer overrides, destruction or every controller. Keep visual/physical revisions aligned.
