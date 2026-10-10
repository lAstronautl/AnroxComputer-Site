# frozen_string_literal: true

# Sort site.posts by front-matter `number` (descending: newest = highest
# number) instead of Jekyll's default date-based order, since most posts
# on this site share the same placeholder date.
#
# Two sorts are needed:
#   1. `site.posts.docs` itself (read by our own plugins/Ruby code).
#   2. `Jekyll::Drops::SiteDrop#posts`, which is what `{{ site.posts }}`
#      actually calls in Liquid templates — it unconditionally re-sorts
#      `docs` with `Document#<=>` (date, falling back to file path) and
#      ignores whatever order `docs` was already in. Without patching it,
#      `{% for post in site.posts %}` in archives.html/elsewhere silently
#      reverts to alphabetical-by-filename order.
Jekyll::Hooks.register :site, :post_read do |site|
  next unless site.posts.docs.any? { |doc| doc.data.key?("number") }

  sorted = site.posts.docs.sort_by { |doc| -(doc.data["number"] || 0) }
  site.posts.docs.replace(sorted)
end

module Jekyll
  module Drops
    class SiteDrop
      def posts
        @site_posts ||= @obj.posts.docs
      end
    end
  end
end
