---
title: That annoying guy's blog
---

<ul>
  <p>Curated list of stuff you can waste your time with</p>
  {% for post in site.posts %}
    <li>
      <a href="{{ post.permalink }}">{{ post.title }}</a>
    </li>
  {% endfor %}
</ul>
