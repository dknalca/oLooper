export interface ScratchQuote {
  text: string;
  attribution: string;
  source?: string;
}

export const SCRATCH_QUOTES: ScratchQuote[] = [
  {
    text: "Hay una cantidad infinita de sonidos. Cualquier sonido que esté grabado, puedes scratcharlo.",
    attribution: "DJ Qbert",
    source: "Red Bull Music Academy Daily",
  },
  {
    text: "Para mí, el plato es el instrumento del futuro.",
    attribution: "Mix Master Mike",
    source: "Bona Fide Mag",
  },
  {
    text: "Quiero pasar el resto de mi vida empujando hacia adelante este arte que me parecía tan increíble y aún me lo parece.",
    attribution: "DJ Craze",
    source: "SPIN",
  },
  {
    text: "Empecé simplemente haciendo scratch, intentando descubrir cómo producir aquellos sonidos misteriosos con el tocadiscos de mi padre.",
    attribution: "A-Trak",
    source: "DJ Times",
  },
  {
    text: "Para algunos era el skate, para otros el graffiti o el deporte. Para mí era el scratch.",
    attribution: "Kid Koala",
    source: "Hip Hop Core",
  },
  {
    text: "La esencia del turntablism para mí es manipular el sonido de maneras inesperadas. Esa es la magia.",
    attribution: "DJ Woody",
    source: "Something You Said",
  },
  {
    text: "Puede que la música que selecciono sea diferente, pero lo que hago sigue siendo hip-hop: turntablism.",
    attribution: "DJ Kentaro",
    source: "I Am Hip-Hop Magazine",
  },
  {
    text: "Ahora se trata principalmente de beat juggling y scratching. Son las dos habilidades principales en las competiciones.",
    attribution: "Roc Raida",
    source: "Red Bull Music Academy Daily",
  },
  {
    text: "Estábamos aprendiendo todas esas técnicas juntos. Alguien las estaba inventando mientras nosotros avanzábamos.",
    attribution: "DJ Jazzy Jeff",
    source: "TNT Magazine",
  },
  {
    text: "Cojo un tocadiscos y hago que haga algo para lo que ni siquiera fue construido; es casi como tener superpoderes.",
    attribution: "DJ Swift (X-Ecutioners)",
  },
  {
    text: "No soy el primer DJ de la historia. Soy el primer DJ que convirtió los platos en un instrumento.",
    attribution: "Grandmaster Flash",
    source: "Berklee",
  },
  {
    text: "Siempre le decía a la gente: ‘Este es mi instrumento, esto es lo que yo toco’.",
    attribution: "Grandmaster Flash",
    source: "Sneaker Freaker",
  },
  {
    text: "Es absolutamente imposible cortar y hacer scratch sin poner los dedos sobre el material original.",
    attribution: "Grandmaster Flash",
    source: "What Hi-Fi?",
  },
  {
    text: "Llegué desde un enfoque científico.",
    attribution: "Grandmaster Flash",
    source: "Sobre cómo desarrolló sus técnicas de DJ · The Washington Post",
  },
  {
    text: "Me enamoré de pinchar, de probar cosas nuevas en el plato.",
    attribution: "Grandmaster Flash",
    source: "Rapchive",
  },
  {
    text: "Cada gran canción tiene una gran parte, y yo me concentré en el break.",
    attribution: "Grandmaster Flash",
    source: "Sneaker Freaker",
  },
  {
    text: "No había ningún punto de referencia, ningún plano; así que estaba constantemente buscando algo.",
    attribution: "Grandmaster Flash",
    source: "Archivo de Aire Fresco",
  },
  {
    text: "Hacía música manipulando el sonido.",
    attribution: "Grandmaster Flash",
    source: "The Guardian",
  },
  {
    text: "Tenía que encontrar una manera de unir todos esos géneros y discos y convertirlos en una sola canción.",
    attribution: "Grandmaster Flash",
    source: "British GQ",
  },
  {
    text: "Pensábamos: si quien toca el piano es pianista, entonces nosotros somos turntablists, porque tocamos el plato como ellos tocan el piano o cualquier otro instrumento.",
    attribution: "DJ Babu",
    source: "DMC World Magazine",
  },
  {
    text: "Quería crear algo que fuera realmente rápido… empecé a dividir el sonido en pequeños clics.",
    attribution: "DJ Flare",
    source: "Sobre el origen del Flare scratch · Ttm Dj",
  },
  {
    text: "Intento ‘hablar’ cuando hago scratch: dejar espacios, cambiar el tono, variar y usar acentos.",
    attribution: "DJ IQ",
    source: "Turntablist World",
  },
  {
    text: "El scratching es infinito en sus combinaciones y está en constante expansión. Música para mis oídos.",
    attribution: "DJ Vajra",
    source: "DMC World Magazine",
  },
  {
    text: "Sigo amando el scratching, sigo practicando mucho y sigo contribuyendo a la escena, porque es lo que amo.",
    attribution: "DJ Netik",
    source: "Ortofon",
  },
  {
    text: "Un plato está desnudo. Es tu selección la que determina en qué instrumento se convierte.",
    attribution: "DJ Rafik",
    source: "JUICE",
  },
  {
    text: "El turntablism siempre será parte de la cultura hip-hop.",
    attribution: "DJ Swamp",
    source: "Phoenix New Times",
  },
  {
    text: "Lo que me mantiene motivado es la música y tratar siempre de pensar en lo que los demás DJs no están haciendo.",
    attribution: "DJ Cash Money",
    source: "HHV Mag",
  },
  {
    text: "Todo gira alrededor del ritmo… tienes que estar a tiempo y dentro del beat en todo lo que haces.",
    attribution: "DJ Cash Money",
    source: "soundsvisualradio.com",
  },
  {
    text: "Lo único que hacía en las fiestas era subirme a una caja de leche y hacer scratch.",
    attribution: "DJ Shortkut",
  },
];

export function randomScratchQuote(): ScratchQuote {
  return SCRATCH_QUOTES[Math.floor(Math.random() * SCRATCH_QUOTES.length)];
}
