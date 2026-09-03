import { useRef } from "react";

import Navbar from "./components/Navbar.js";
import Journey from "./journey/Journey.js";
import Petals, { type PetalFieldHandle } from "./journey/Petals.js";
import Footer from "./sections/Footer.js";

export default function App() {
  /*
   * One petal field for the whole page. The boughs in the FAQ act and the
   * drift in the footer are the same particles — nothing is emitted at the
   * footer's top edge, so the fall reads as continuous across the two. The
   * journey drives it; the footer is where it lands.
   */
  const petalsRef = useRef<PetalFieldHandle>(null);

  return (
    <>
      {/* Mounted before the journey: the journey cues the field from a layout
          effect, and a component further down the tree would not have attached
          its imperative handle yet — the hero would then never be told to
          shed. Stacking is set in CSS, so DOM order costs nothing here. */}
      <Petals
        ref={petalsRef}
        trackSelector=".hero-tree"
        floorSelector=".footer"
        fillSelector=".footer__wordmark"
        max={880}
        interactive
      />

      <Navbar />

      <main id="top">
        <Journey petalsRef={petalsRef} />
      </main>

      <Footer />
    </>
  );
}
